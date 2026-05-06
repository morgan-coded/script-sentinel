import { describe, expect, it } from "vitest";

import { redirectDirectAppLaunch } from "./direct-launch.server";

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://script-sentinel.example${path}`, {
    headers: { Accept: "text/html" },
    ...init,
  });
}

function redirectedLocation(path: string, init?: RequestInit): string | null {
  try {
    redirectDirectAppLaunch(request(path, init));
    return null;
  } catch (error) {
    return error instanceof Response ? error.headers.get("Location") : null;
  }
}

describe("redirectDirectAppLaunch", () => {
  it("sends app routes without Shopify context to the login page", () => {
    expect(redirectedLocation("/app")).toBe("/auth/login");
    expect(redirectedLocation("/app/scripts")).toBe("/auth/login");
  });

  it("preserves shop when restarting OAuth from an app route", () => {
    expect(redirectedLocation("/app?shop=demo-store.myshopify.com")).toBe(
      "/auth/login?shop=demo-store.myshopify.com",
    );
  });

  it("does not interrupt signed Shopify launches or established sessions", () => {
    expect(redirectedLocation("/app?shop=demo.myshopify.com&host=abc")).toBe(
      null,
    );
    expect(
      redirectedLocation("/app", {
        headers: { Cookie: "shopify_app_session=session-id" },
      }),
    ).toBe(null);
  });
});
