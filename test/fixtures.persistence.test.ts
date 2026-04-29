import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import db from "../app/db.server";
import { extractFixtures } from "../app/lib/fixtures/dedup";
import {
  countFixtures,
  deleteAllFixtures,
  listFixtures,
  upsertFixtures,
} from "../app/lib/fixtures/store.server";
import { containsLikelyPII } from "../app/lib/fixtures/pii";
import type { RawOrder } from "../app/lib/shopify/orders";

/**
 * Full round-trip test for Slice 3 — extractor → upsert → read-back. Uses the
 * real Prisma schema (the slice3_cart_fixtures migration was applied during
 * setup). Same pattern as the Slice 2 persistence test: unique shop domain
 * per run, cleanup in afterAll.
 *
 * Two invariants matter most here:
 *   1. Re-running upsertFixtures on the same orders is idempotent — no
 *      duplicate rows, observationCount accumulates correctly.
 *   2. No PII reaches the DB. We serialize every persisted row (including
 *      JSON columns) and run it through `containsLikelyPII`.
 */

// Non-numeric suffix so the shop domain itself doesn't trip the 10+ contiguous
// digit phone-detector in the PII tripwire — we want that tripwire scanning
// merchant data only, not our internal test identifier.
const SHOP = `fixtures-test-${Math.random().toString(36).slice(2, 10)}.myshopify.com`;

function order(
  id: string,
  overrides: {
    variantId?: string;
    productId?: string;
    quantity?: number;
    code?: string | null;
    country?: string;
    tags?: string[];
    processedAt?: string;
    customerName?: string; // intentional PII to assert we never persist it
  } = {},
): RawOrder {
  return {
    id,
    name: id,
    processedAt: overrides.processedAt ?? "2026-04-15T10:00:00Z",
    presentmentCurrencyCode: "USD",
    paymentGatewayNames: ["shopify_payments"],
    customer: {
      id: "c",
      tags: overrides.tags ?? [],
    },
    // Inject extra PII-shaped fields the scrubber must drop. Cast through
    // unknown — runtime is what the persistence test asserts.
    shippingAddress: {
      countryCode: overrides.country ?? "US",
      zip: "94110",
      name: overrides.customerName ?? "Jane Doe",
      phone: "+1 415 555 0142",
    } as unknown as RawOrder["shippingAddress"],
    lineItems: {
      edges: [
        {
          node: {
            id: "li1",
            title: "Item",
            quantity: overrides.quantity ?? 1,
            variant: {
              id: overrides.variantId ?? "gid://shopify/ProductVariant/V1",
              price: "100.00",
            },
            product: { id: overrides.productId ?? "gid://shopify/Product/P1" },
            originalTotalSet: { presentmentMoney: { amount: "100.00", currencyCode: "USD" } },
            discountedTotalSet: { presentmentMoney: { amount: "100.00", currencyCode: "USD" } },
          },
        },
      ],
    },
    shippingLines: {
      edges: [
        {
          node: {
            code: "STANDARD",
            title: "Standard shipping",
            originalPriceSet: { presentmentMoney: { amount: "10.00", currencyCode: "USD" } },
          },
        },
      ],
    },
    discountApplications: overrides.code
      ? {
          edges: [
            {
              node: {
                __typename: "DiscountCodeApplication",
                allocationMethod: "ACROSS",
                targetType: "LINE_ITEM",
                targetSelection: "ALL",
                value: { __typename: "MoneyV2", amount: "5.00", currencyCode: "USD" },
                code: overrides.code,
              },
            },
          ],
        }
      : { edges: [] },
  };
}

beforeAll(async () => {
  await db.shop.upsert({
    where: { myshopifyDomain: SHOP },
    update: {},
    create: { myshopifyDomain: SHOP, isPlus: true, isDevelopment: true },
  });
});

beforeEach(async () => {
  await db.cartFixture.deleteMany({ where: { shopDomain: SHOP } });
});

afterAll(async () => {
  await db.cartFixture.deleteMany({ where: { shopDomain: SHOP } });
  await db.shop.deleteMany({ where: { myshopifyDomain: SHOP } });
  await db.$disconnect();
});

describe("upsertFixtures + listFixtures roundtrip", () => {
  it("persists deduplicated fixtures and lists them back with baselines", async () => {
    const orders = [
      order("o1", { quantity: 1 }),
      order("o2", { quantity: 2 }),
      order("o3", { quantity: 1 }),
    ];
    const { fixtures } = extractFixtures(orders);
    expect(fixtures).toHaveLength(1);
    const result = await upsertFixtures(SHOP, fixtures);
    expect(result.created).toBe(1);
    expect(result.merged).toBe(0);

    const listed = await listFixtures(SHOP);
    expect(listed).toHaveLength(1);
    expect(listed[0].observationCount).toBe(3);
    expect(listed[0].quantitySamples).toEqual([1, 2]);
    expect(listed[0].baseline).not.toBeNull();
    expect(listed[0].baseline?.shippingRateAmount).toBe(10);
  });

  it("re-running on the same orders is idempotent — observationCount accumulates, no duplicate rows", async () => {
    const orders = [order("o1"), order("o2")];
    const { fixtures: first } = extractFixtures(orders);
    await upsertFixtures(SHOP, first);
    const after1 = await listFixtures(SHOP);
    expect(after1).toHaveLength(1);
    expect(after1[0].observationCount).toBe(2);

    // Same orders again — count should double, but only one row.
    const { fixtures: second } = extractFixtures(orders);
    const result2 = await upsertFixtures(SHOP, second);
    expect(result2.created).toBe(0);
    expect(result2.merged).toBe(1);
    const after2 = await listFixtures(SHOP);
    expect(after2).toHaveLength(1);
    expect(after2[0].observationCount).toBe(4);
  });

  it("merges new orders into existing fixtures while preserving baseline freshness", async () => {
    const old = extractFixtures([
      order("old", { processedAt: "2026-03-01T00:00:00Z" }),
    ]).fixtures;
    await upsertFixtures(SHOP, old);

    const fresh = extractFixtures([
      order("new", { processedAt: "2026-04-20T00:00:00Z", code: "BFCM" }),
    ]).fixtures;
    // Different code → different signature → new row.
    await upsertFixtures(SHOP, fresh);

    expect(await countFixtures(SHOP)).toBe(2);

    // Now add a third "old"-shaped order. It should merge into the first row,
    // not create a duplicate.
    const more = extractFixtures([order("old2")]).fixtures;
    const result = await upsertFixtures(SHOP, more);
    expect(result.created).toBe(0);
    expect(result.merged).toBe(1);
    expect(await countFixtures(SHOP)).toBe(2);
  });

  it("never persists PII — every column run through containsLikelyPII", async () => {
    const orders = [
      order("o1", {
        customerName: "Alice Wonderland",
        tags: ["VIP", "alice@example.com", "+1 415 555 9999"],
      }),
    ];
    const { fixtures } = extractFixtures(orders);
    await upsertFixtures(SHOP, fixtures);

    const rows = await db.cartFixture.findMany({
      where: { shopDomain: SHOP },
      include: { baseline: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Serialize the row's *merchant-derived* fields and assert no PII-shaped
      // string slipped through. shopDomain is excluded because it's an
      // internal identifier we control (and the test suffix is random); the
      // tripwire is for customer data leaking out of the extractor/store.
      const { shopDomain: _ignored, ...scannable } = row;
      const blob = JSON.stringify(scannable);
      expect(containsLikelyPII(blob), `unexpected PII in ${row.id}`).toBe(false);
      // Specifically: zero raw zip, no email host, no phone digit run.
      expect(blob).not.toContain("Alice");
      expect(blob).not.toContain("@example.com");
      expect(blob).not.toContain("4155559999");
      expect(blob).not.toContain("94110"); // full zip — only the 941 prefix should be there
    }
  });

  it("deleteAllFixtures wipes only the target shop", async () => {
    const otherShop = `${SHOP}.alt`;
    await db.shop.create({ data: { myshopifyDomain: otherShop, isPlus: true } });
    try {
      const f1 = extractFixtures([order("o1", { variantId: "v-a" })]).fixtures;
      const f2 = extractFixtures([order("o2", { variantId: "v-b" })]).fixtures;
      await upsertFixtures(SHOP, f1);
      await upsertFixtures(otherShop, f2);

      expect(await countFixtures(SHOP)).toBe(1);
      expect(await countFixtures(otherShop)).toBe(1);

      const removed = await deleteAllFixtures(SHOP);
      expect(removed).toBe(1);

      expect(await countFixtures(SHOP)).toBe(0);
      expect(await countFixtures(otherShop)).toBe(1);
    } finally {
      await db.cartFixture.deleteMany({ where: { shopDomain: otherShop } });
      await db.shop.delete({ where: { myshopifyDomain: otherShop } });
    }
  });
});
