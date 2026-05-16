import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * Webhook signature verification is enforced by `authenticate.webhook(request)`
 * inside @shopify/shopify-app-remix using HMAC-SHA256 of the raw body keyed on
 * SHOPIFY_API_SECRET. Re-implementing or asserting Shopify's HMAC scheme in our
 * own tests would just be testing the library.
 *
 * What we DO want to test on our side is the handler contract:
 *   1. We never run cleanup for a request that produced no session (because
 *      authenticate.webhook found nothing — e.g. webhook arrived after a prior
 *      uninstall already ran). Important: the action must still respond 200.
 *   2. When a session IS returned, we call markShopUninstalled with the right
 *      shop. That's the integration point with our DB.
 *
 * We mock the two collaborators (`authenticate` and `markShopUninstalled`) and
 * assert the action calls them in the expected sequence.
 */

const authenticateMock = {
  webhook: vi.fn(),
};
const markShopUninstalledMock = vi.fn();

vi.mock("../../app/shopify.server", () => ({
  authenticate: authenticateMock,
}));

vi.mock("../../app/lib/shopify/shop.server", () => ({
  markShopUninstalled: markShopUninstalledMock,
}));

// Import AFTER mocks are registered.
const { action } = await import("../../app/routes/webhooks.app.uninstalled");

beforeEach(() => {
  authenticateMock.webhook.mockReset();
  markShopUninstalledMock.mockReset();
});

describe("app/uninstalled webhook handler", () => {
  it("calls markShopUninstalled when a session is present", async () => {
    authenticateMock.webhook.mockResolvedValueOnce({
      shop: "acme.myshopify.com",
      session: { id: "offline_acme.myshopify.com", shop: "acme.myshopify.com" },
      topic: "APP_UNINSTALLED",
    });

    const request = new Request("https://app.example/webhooks/app/uninstalled", {
      method: "POST",
      body: "{}",
    });

    const response = await action({ request, params: {}, context: {} } as any);

    expect(authenticateMock.webhook).toHaveBeenCalledWith(request);
    expect(markShopUninstalledMock).toHaveBeenCalledWith("acme.myshopify.com");
    expect(response.status).toBe(200);
  });

  it("is idempotent — no cleanup when authenticate.webhook returns no session", async () => {
    authenticateMock.webhook.mockResolvedValueOnce({
      shop: "acme.myshopify.com",
      session: null,
      topic: "APP_UNINSTALLED",
    });

    const request = new Request("https://app.example/webhooks/app/uninstalled", {
      method: "POST",
      body: "{}",
    });

    const response = await action({ request, params: {}, context: {} } as any);

    expect(markShopUninstalledMock).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("propagates signature-verification failures from authenticate.webhook", async () => {
    // authenticate.webhook throws on bad HMAC. The handler should not swallow
    // that — Shopify retries on non-2xx, and a forged request must be rejected.
    authenticateMock.webhook.mockRejectedValueOnce(
      new Response("Unauthorized", { status: 401 }),
    );

    const request = new Request("https://app.example/webhooks/app/uninstalled", {
      method: "POST",
      body: "{}",
    });

    await expect(
      action({ request, params: {}, context: {} } as any),
    ).rejects.toBeInstanceOf(Response);
    expect(markShopUninstalledMock).not.toHaveBeenCalled();
  });
});
