import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import db from "../app/db.server";
import {
  buildCategoryAttributionMap,
  countAllFunctionOutputs,
  finishCaptureRun,
  listCaptureRuns,
  listDiscoveredFunctions,
  listFunctionOutputs,
  persistFunctionOutputsFromOrders,
  startCaptureRun,
  upsertDiscoveredFunctions,
} from "../app/lib/functions/store.server";
import type { RawShopifyFunction } from "../app/lib/shopify/functions";
import type { RawOrder } from "../app/lib/shopify/orders";

/**
 * Round-trip test for the functions capture pipeline — discovery upsert,
 * capture-run lifecycle, function-output persistence + idempotent re-runs.
 * Uses the real Prisma schema (the functions-capture migration was applied
 * in setup).
 */

const SHOP = `functions-test-${Math.random().toString(36).slice(2, 10)}.myshopify.com`;

function rawFn(id: string, apiType: string, title: string): RawShopifyFunction {
  return {
    id,
    title,
    apiType,
    apiVersion: "2026-04",
    app: { title: "Test Functions app" },
  };
}

function rawOrder(
  id: string,
  options: {
    discountAmount?: number;
    shippingCode?: string | null;
    shippingAmount?: number | null;
    paymentGateway?: string;
    processedAt?: string;
    productId?: string;
    code?: string | null;
  } = {},
): RawOrder {
  const original = 100;
  const discounted = original - (options.discountAmount ?? 0);
  return {
    id,
    name: id,
    processedAt: options.processedAt ?? "2026-04-20T10:00:00Z",
    presentmentCurrencyCode: "USD",
    paymentGatewayNames: [options.paymentGateway ?? "shopify_payments"],
    customer: { id: "c", tags: [] },
    shippingAddress: { countryCode: "US", zip: "94110" },
    lineItems: {
      edges: [
        {
          node: {
            id: "li1",
            title: "Item",
            quantity: 1,
            variant: { id: "gid://shopify/ProductVariant/V1", price: "100.00" },
            product: { id: options.productId ?? "gid://shopify/Product/P1" },
            originalTotalSet: {
              presentmentMoney: { amount: original.toFixed(2), currencyCode: "USD" },
            },
            discountedTotalSet: {
              presentmentMoney: { amount: discounted.toFixed(2), currencyCode: "USD" },
            },
          },
        },
      ],
    },
    shippingLines:
      options.shippingCode === null
        ? { edges: [] }
        : {
            edges: [
              {
                node: {
                  code: options.shippingCode ?? "STANDARD",
                  title: "Standard",
                  originalPriceSet: {
                    presentmentMoney: {
                      amount: (options.shippingAmount ?? 10).toFixed(2),
                      currencyCode: "USD",
                    },
                  },
                },
              },
            ],
          },
    discountApplications: options.code
      ? {
          edges: [
            {
              node: {
                __typename: "DiscountCodeApplication",
                allocationMethod: "ACROSS",
                targetType: "LINE_ITEM",
                targetSelection: "ALL",
                value: { __typename: "MoneyV2", amount: "5.00", currencyCode: "USD" },
                code: options.code,
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
  await db.functionOutput.deleteMany({ where: { shopDomain: SHOP } });
  await db.captureRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.discoveredFunction.deleteMany({ where: { shopDomain: SHOP } });
});

afterAll(async () => {
  await db.functionOutput.deleteMany({ where: { shopDomain: SHOP } });
  await db.captureRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.discoveredFunction.deleteMany({ where: { shopDomain: SHOP } });
  await db.shop.deleteMany({ where: { myshopifyDomain: SHOP } });
  await db.$disconnect();
});

describe("upsertDiscoveredFunctions", () => {
  it("creates rows on first discovery, updates on subsequent runs, marks disappeared as uninstalled", async () => {
    const a = rawFn("gid://shopify/ShopifyFunction/A", "discounts", "Discount A");
    const b = rawFn("gid://shopify/ShopifyFunction/B", "delivery_customization", "Shipping B");

    const r1 = await upsertDiscoveredFunctions(SHOP, [a, b]);
    expect(r1).toEqual({ created: 2, updated: 0, uninstalled: 0 });

    let listed = await listDiscoveredFunctions(SHOP);
    expect(listed).toHaveLength(2);
    expect(listed.find((f) => f.externalId === a.id)?.category).toBe("discount");
    expect(listed.find((f) => f.externalId === b.id)?.category).toBe("shipping");

    // Re-run with only A → B should be marked uninstalled.
    const r2 = await upsertDiscoveredFunctions(SHOP, [a]);
    expect(r2).toEqual({ created: 0, updated: 1, uninstalled: 1 });

    listed = await listDiscoveredFunctions(SHOP);
    const bRow = listed.find((f) => f.externalId === b.id);
    expect(bRow?.uninstalledAt).toBeInstanceOf(Date);

    // Re-run with both → B comes back, uninstalledAt cleared.
    const r3 = await upsertDiscoveredFunctions(SHOP, [a, b]);
    expect(r3).toEqual({ created: 0, updated: 2, uninstalled: 0 });
    listed = await listDiscoveredFunctions(SHOP);
    expect(listed.find((f) => f.externalId === b.id)?.uninstalledAt).toBeNull();
  });

  it("returns empty list (no error) when no Functions are deployed", async () => {
    const result = await upsertDiscoveredFunctions(SHOP, []);
    expect(result).toEqual({ created: 0, updated: 0, uninstalled: 0 });
    expect(await listDiscoveredFunctions(SHOP)).toEqual([]);
  });
});

describe("buildCategoryAttributionMap", () => {
  it("attributes each category to the first installed Function of that category", async () => {
    await upsertDiscoveredFunctions(SHOP, [
      rawFn("gid://shopify/ShopifyFunction/D1", "discounts", "Discount 1"),
      rawFn("gid://shopify/ShopifyFunction/D2", "discounts", "Discount 2"),
      rawFn("gid://shopify/ShopifyFunction/S1", "delivery_customization", "Shipping"),
    ]);
    const fns = await listDiscoveredFunctions(SHOP);
    const map = buildCategoryAttributionMap(fns);
    // First-discovered discount Function wins. Listing is ordered by title
    // ascending, so "Discount 1" beats "Discount 2".
    expect(map.get("discount")).toBeTruthy();
    expect(map.get("shipping")).toBeTruthy();
    expect(map.get("payment")).toBeUndefined();
  });

  it("skips uninstalled Functions even when they exist in the row set", async () => {
    await upsertDiscoveredFunctions(SHOP, [
      rawFn("gid://shopify/ShopifyFunction/D1", "discounts", "Old discount"),
    ]);
    await upsertDiscoveredFunctions(SHOP, []); // mark D1 uninstalled
    const fns = await listDiscoveredFunctions(SHOP);
    const map = buildCategoryAttributionMap(fns);
    expect(map.get("discount")).toBeUndefined();
  });
});

describe("CaptureRun lifecycle + persistFunctionOutputsFromOrders", () => {
  it("persists per-order outputs attributed by category and is idempotent on re-runs", async () => {
    await upsertDiscoveredFunctions(SHOP, [
      rawFn("gid://shopify/ShopifyFunction/D", "discounts", "Discount Function"),
    ]);
    const fns = await listDiscoveredFunctions(SHOP);
    const attribution = buildCategoryAttributionMap(fns);

    const run = await startCaptureRun(SHOP, {
      from: new Date("2026-04-15T00:00:00Z"),
      to: new Date("2026-04-29T00:00:00Z"),
    });

    const orders = [
      rawOrder("gid://shopify/Order/1", { discountAmount: 10, code: "SAVE10" }),
      rawOrder("gid://shopify/Order/2", { discountAmount: 0, shippingCode: "STANDARD" }),
    ];
    const summary1 = await persistFunctionOutputsFromOrders(
      SHOP,
      run.id,
      orders,
      attribution,
    );
    expect(summary1).toEqual({ outputsCaptured: 2, ordersConsidered: 2 });

    // Re-run with the same orders — uniqueness on (shop, signature, orderGid)
    // means zero new rows.
    const summary2 = await persistFunctionOutputsFromOrders(
      SHOP,
      run.id,
      orders,
      attribution,
    );
    expect(summary2).toEqual({ outputsCaptured: 0, ordersConsidered: 2 });

    const all = await listFunctionOutputs(SHOP);
    expect(all).toHaveLength(2);
    const discountRow = all.find((o) => o.observedDiscountAmount > 0);
    expect(discountRow?.observedDiscountCodes).toEqual(["SAVE10"]);
    expect(discountRow?.functionId).toBe(attribution.get("discount"));
    // The second order had no discount → no discount Function attribution;
    // shipping Function isn't installed so it stays null.
    const shippingRow = all.find((o) => o.observedDiscountAmount === 0);
    expect(shippingRow?.functionId).toBeNull();

    await finishCaptureRun(run.id, {
      status: "completed",
      ordersExamined: 2,
      outputsCaptured: 2,
    });
    const runs = await listCaptureRuns(SHOP);
    expect(runs[0].status).toBe("completed");
  });

  it("countAllFunctionOutputs only marks the dashboard capture step done after real outputs land", async () => {
    // Review-response fix: a CaptureRun (or downstream drift run) that
    // produced zero outputs must not flip the stepper to 'done'.
    expect(await countAllFunctionOutputs(SHOP)).toBe(0);

    const run = await startCaptureRun(SHOP, {
      from: new Date("2026-04-15T00:00:00Z"),
      to: new Date("2026-04-29T00:00:00Z"),
    });
    await finishCaptureRun(run.id, {
      status: "completed",
      ordersExamined: 7,
      outputsCaptured: 0,
    });
    // Empty CaptureRun → still zero outputs, stepper must stay 'todo'.
    expect(await countAllFunctionOutputs(SHOP)).toBe(0);

    await persistFunctionOutputsFromOrders(
      SHOP,
      run.id,
      [rawOrder("gid://shopify/Order/CountTest", { discountAmount: 5 })],
      new Map(),
    );
    expect(await countAllFunctionOutputs(SHOP)).toBe(1);
  });

  it("gracefully handles empty-order runs (phase defensive contract)", async () => {
    await upsertDiscoveredFunctions(SHOP, []);
    const run = await startCaptureRun(SHOP, {
      from: new Date(),
      to: new Date(),
    });
    const summary = await persistFunctionOutputsFromOrders(
      SHOP,
      run.id,
      [],
      new Map(),
    );
    expect(summary).toEqual({ outputsCaptured: 0, ordersConsidered: 0 });
    await finishCaptureRun(run.id, {
      status: "completed",
      ordersExamined: 0,
      outputsCaptured: 0,
    });
    expect(await listFunctionOutputs(SHOP)).toEqual([]);
  });

  it("scopes outputs strictly to the shop (never leaks cross-shop)", async () => {
    const otherShop = `${SHOP}.alt`;
    await db.shop.create({
      data: { myshopifyDomain: otherShop, isPlus: true, isDevelopment: true },
    });
    try {
      const ours = await startCaptureRun(SHOP, {
        from: new Date(),
        to: new Date(),
      });
      const theirs = await startCaptureRun(otherShop, {
        from: new Date(),
        to: new Date(),
      });
      await persistFunctionOutputsFromOrders(
        SHOP,
        ours.id,
        [rawOrder("gid://shopify/Order/X", { discountAmount: 5 })],
        new Map(),
      );
      await persistFunctionOutputsFromOrders(
        otherShop,
        theirs.id,
        [
          rawOrder("gid://shopify/Order/Y", {
            discountAmount: 99,
            productId: "gid://shopify/Product/Other",
          }),
        ],
        new Map(),
      );
      expect(await listFunctionOutputs(SHOP)).toHaveLength(1);
      expect(await listFunctionOutputs(otherShop)).toHaveLength(1);
    } finally {
      await db.functionOutput.deleteMany({ where: { shopDomain: otherShop } });
      await db.captureRun.deleteMany({ where: { shopDomain: otherShop } });
      await db.shop.delete({ where: { myshopifyDomain: otherShop } });
    }
  });
});
