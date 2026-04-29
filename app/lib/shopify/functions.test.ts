import { describe, expect, it, vi } from "vitest";
import {
  categorizeApiType,
  fetchAllFunctions,
  FunctionsAccessDeniedError,
  type AdminGraphqlClient,
  type RawShopifyFunction,
} from "./functions";

function makeFn(id: string, apiType = "discounts"): RawShopifyFunction {
  return {
    id,
    title: `Function ${id}`,
    apiType,
    apiVersion: "2026-04",
    app: { title: "Test app" },
  };
}

function mockAdmin(
  pages: Array<{ functions: RawShopifyFunction[]; nextCursor: string | null }>,
): AdminGraphqlClient {
  let call = 0;
  return {
    graphql: vi.fn(async () => {
      const page = pages[call++];
      if (!page) throw new Error(`unexpected page request ${call}`);
      return {
        json: async () => ({
          data: {
            shopifyFunctions: {
              pageInfo: {
                hasNextPage: page.nextCursor !== null,
                endCursor: page.nextCursor,
              },
              edges: page.functions.map((f, i) => ({
                cursor: `cur-${call}-${i}`,
                node: f,
              })),
            },
          },
        }),
      };
    }),
  };
}

describe("categorizeApiType", () => {
  it("maps the four canonical 2026-04 apiTypes", () => {
    expect(categorizeApiType("discounts")).toBe("discount");
    expect(categorizeApiType("product_discounts")).toBe("discount");
    expect(categorizeApiType("delivery_customization")).toBe("shipping");
    expect(categorizeApiType("shipping_discounts")).toBe("shipping");
    expect(categorizeApiType("payment_customization")).toBe("payment");
    expect(categorizeApiType("cart_transform")).toBe("other");
  });

  it("falls back to 'other' for null / unknown apiTypes (defensive)", () => {
    expect(categorizeApiType(null)).toBe("other");
    expect(categorizeApiType(undefined)).toBe("other");
    expect(categorizeApiType("")).toBe("other");
    expect(categorizeApiType("brand_new_api_type_2027")).toBe("other");
  });

  it("recognises market and b2b hints case-insensitively", () => {
    expect(categorizeApiType("MARKET_PRICING")).toBe("market_pricing");
    expect(categorizeApiType("b2b_catalog")).toBe("b2b");
  });
});

describe("fetchAllFunctions", () => {
  it("paginates with cursor until hasNextPage is false", async () => {
    const admin = mockAdmin([
      { functions: [makeFn("1"), makeFn("2")], nextCursor: "cur-1" },
      { functions: [makeFn("3")], nextCursor: null },
    ]);
    const result = await fetchAllFunctions(admin);
    expect(result.functions.map((f) => f.id)).toEqual(["1", "2", "3"]);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
  });

  it("stops at maxFunctions and reports truncated", async () => {
    const admin = mockAdmin([
      { functions: [makeFn("1"), makeFn("2"), makeFn("3")], nextCursor: "cur-1" },
    ]);
    const result = await fetchAllFunctions(admin, { maxFunctions: 2, pageSize: 3 });
    expect(result.functions).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("returns empty result for shops with no Functions installed", async () => {
    const admin = mockAdmin([{ functions: [], nextCursor: null }]);
    const result = await fetchAllFunctions(admin);
    expect(result.functions).toEqual([]);
    expect(result.pagesFetched).toBe(1);
  });

  it("throws FunctionsAccessDeniedError when the API rejects on scope grounds", async () => {
    const admin: AdminGraphqlClient = {
      graphql: async () => ({
        json: async () => ({
          errors: [{ message: "Access denied: shopifyFunctions requires read_apps scope" }],
        }),
      }),
    };
    await expect(fetchAllFunctions(admin)).rejects.toBeInstanceOf(FunctionsAccessDeniedError);
  });

  it("propagates non-access GraphQL errors as plain Error (so the loader 5xx's)", async () => {
    const admin: AdminGraphqlClient = {
      graphql: async () => ({
        json: async () => ({ errors: [{ message: "Internal server error" }] }),
      }),
    };
    await expect(fetchAllFunctions(admin)).rejects.toThrow(/shopifyFunctions query failed/);
  });

  it("skips edges with no node (defensive against schema drift)", async () => {
    const admin: AdminGraphqlClient = {
      graphql: vi.fn(async () => ({
        json: async () => ({
          data: {
            shopifyFunctions: {
              pageInfo: { hasNextPage: false, endCursor: null },
              edges: [
                { cursor: "a", node: makeFn("1") },
                { cursor: "b", node: null },
                null,
                { cursor: "d", node: makeFn("2") },
              ],
            },
          },
        }),
      })),
    };
    const result = await fetchAllFunctions(admin);
    expect(result.functions.map((f) => f.id)).toEqual(["1", "2"]);
  });
});
