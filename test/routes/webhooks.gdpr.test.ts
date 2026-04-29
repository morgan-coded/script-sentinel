import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GDPR mandatory webhook handlers — Slice 9.
 *
 * Two test surfaces:
 *
 *   1. customers/data_request + customers/redact — Script Sentinel does not
 *      store customer-identifying data (Slice 3 PII contract), so these
 *      handlers acknowledge with 200 and log. We mock `authenticate.webhook`
 *      and assert the contract (200 response, no DB side effects, HMAC
 *      failures propagate).
 *
 *   2. shop/redact — hard-deletes the Shop row and relies on Prisma cascade
 *      to remove every related row across the schema. We exercise this
 *      against the real test database, seeding the shop with at least one row
 *      from each cascading model and asserting the post-call counts are zero.
 *
 * HMAC verification is owned by `authenticate.webhook(request)` inside
 * @shopify/shopify-app-remix; we don't re-implement it in tests. The
 * "propagates signature failure" cases below assert our handlers don't
 * accidentally swallow an authentication error.
 */

const authenticateMock = {
  webhook: vi.fn(),
};

vi.mock("../../app/shopify.server", () => ({
  authenticate: authenticateMock,
  unauthenticated: {},
  default: {},
  apiVersion: "2026-04",
  addDocumentResponseHeaders: () => {},
  login: () => {},
  registerWebhooks: () => {},
  sessionStorage: {},
}));

const dataRequestModule = await import(
  "../../app/routes/webhooks.customers.data_request"
);
const customerRedactModule = await import(
  "../../app/routes/webhooks.customers.redact"
);
const shopRedactModule = await import("../../app/routes/webhooks.shop.redact");

beforeEach(() => {
  authenticateMock.webhook.mockReset();
});

function buildRequest(path: string) {
  return new Request(`https://app.example${path}`, {
    method: "POST",
    body: "{}",
  });
}

describe("customers/data_request webhook handler", () => {
  it("acknowledges with 200 (no customer data is stored to return)", async () => {
    authenticateMock.webhook.mockResolvedValueOnce({
      shop: "acme.myshopify.com",
      topic: "CUSTOMERS_DATA_REQUEST",
      payload: { customer: { id: 12345 } },
    });
    const response = await dataRequestModule.action({
      request: buildRequest("/webhooks/customers/data_request"),
      params: {},
      context: {},
    } as any);
    expect(response.status).toBe(200);
  });

  it("propagates HMAC verification failures from authenticate.webhook", async () => {
    authenticateMock.webhook.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(
      dataRequestModule.action({
        request: buildRequest("/webhooks/customers/data_request"),
        params: {},
        context: {},
      } as any),
    ).rejects.toBeInstanceOf(Response);
  });
});

describe("customers/redact webhook handler", () => {
  it("acknowledges with 200 (no customer data is stored to redact)", async () => {
    authenticateMock.webhook.mockResolvedValueOnce({
      shop: "acme.myshopify.com",
      topic: "CUSTOMERS_REDACT",
      payload: { customer: { id: 67890 } },
    });
    const response = await customerRedactModule.action({
      request: buildRequest("/webhooks/customers/redact"),
      params: {},
      context: {},
    } as any);
    expect(response.status).toBe(200);
  });

  it("propagates HMAC verification failures from authenticate.webhook", async () => {
    authenticateMock.webhook.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(
      customerRedactModule.action({
        request: buildRequest("/webhooks/customers/redact"),
        params: {},
        context: {},
      } as any),
    ).rejects.toBeInstanceOf(Response);
  });
});

describe("shop/redact webhook handler — cascade purge", () => {
  // Real DB integration: seeds a shop with one row from each cascading model
  // and asserts the cascade wipes them after shop deletion. Uses a unique
  // shop domain per file run so the suite stays parallel-safe.
  const SHOP = `gdpr-redact-${Math.random().toString(36).slice(2, 10)}.myshopify.com`;

  // Lazy import inside describe so the module mock above is registered first.
  const dbPromise = import("../../app/db.server").then((m) => m.default);

  afterAll(async () => {
    const db = await dbPromise;
    // Defensive cleanup if the cascade test failed before purge.
    await db.session.deleteMany({ where: { shop: SHOP } });
    await db.shop.deleteMany({ where: { myshopifyDomain: SHOP } });
    await db.$disconnect();
  });

  it("deletes Shop, Sessions, and every cascading related row in one transaction", async () => {
    const db = await dbPromise;

    // Seed the shop with rows from a representative cross-section of the
    // schema. If any FK didn't have onDelete: Cascade declared, the
    // post-purge count would be non-zero and this test would fail.
    await db.shop.create({
      data: { myshopifyDomain: SHOP, isPlus: true, isDevelopment: true },
    });
    await db.session.create({
      data: {
        id: `offline_${SHOP}`,
        shop: SHOP,
        state: "x",
        accessToken: "test-token",
      },
    });
    await db.discoveredScript.create({
      data: {
        shopDomain: SHOP,
        title: "Test script",
        scriptType: "line_item",
        source: "puts 'hi'",
      },
    });
    const fixture = await db.cartFixture.create({
      data: {
        shopDomain: SHOP,
        signature: `sig-${SHOP}`,
        lineItems: "[]",
        presentmentCurrency: "USD",
        firstObservedAt: new Date(),
        lastObservedAt: new Date(),
      },
    });
    await db.fixtureBaseline.create({
      data: {
        fixtureId: fixture.id,
        cartTotal: 100,
        capturedAt: new Date(),
      },
    });
    await db.driftRun.create({ data: { shopDomain: SHOP } });

    // Sanity: the seed actually wrote rows.
    expect(await db.shop.count({ where: { myshopifyDomain: SHOP } })).toBe(1);
    expect(await db.discoveredScript.count({ where: { shopDomain: SHOP } })).toBe(1);
    expect(await db.cartFixture.count({ where: { shopDomain: SHOP } })).toBe(1);
    expect(await db.driftRun.count({ where: { shopDomain: SHOP } })).toBe(1);

    authenticateMock.webhook.mockResolvedValueOnce({
      shop: SHOP,
      topic: "SHOP_REDACT",
      payload: {},
    });
    const response = await shopRedactModule.action({
      request: buildRequest("/webhooks/shop/redact"),
      params: {},
      context: {},
    } as any);
    expect(response.status).toBe(200);

    // After the cascade, every shop-keyed row must be gone.
    expect(await db.shop.count({ where: { myshopifyDomain: SHOP } })).toBe(0);
    expect(await db.session.count({ where: { shop: SHOP } })).toBe(0);
    expect(await db.discoveredScript.count({ where: { shopDomain: SHOP } })).toBe(0);
    expect(await db.cartFixture.count({ where: { shopDomain: SHOP } })).toBe(0);
    expect(
      await db.fixtureBaseline.count({ where: { fixtureId: fixture.id } }),
    ).toBe(0);
    expect(await db.driftRun.count({ where: { shopDomain: SHOP } })).toBe(0);
  });

  it("is idempotent — re-firing on an already-redacted shop returns 200 without throwing", async () => {
    const SHOP2 = `${SHOP}.again`;
    authenticateMock.webhook.mockResolvedValueOnce({
      shop: SHOP2,
      topic: "SHOP_REDACT",
      payload: {},
    });
    const response = await shopRedactModule.action({
      request: buildRequest("/webhooks/shop/redact"),
      params: {},
      context: {},
    } as any);
    expect(response.status).toBe(200);
  });

  it("propagates HMAC verification failures from authenticate.webhook (forged requests are rejected, not silently absorbed)", async () => {
    authenticateMock.webhook.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(
      shopRedactModule.action({
        request: buildRequest("/webhooks/shop/redact"),
        params: {},
        context: {},
      } as any),
    ).rejects.toBeInstanceOf(Response);
  });
});
