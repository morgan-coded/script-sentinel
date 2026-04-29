import { describe, expect, it, vi } from "vitest";
import {
  buildOrdersQuery,
  DEFAULT_LOOKBACK_DAYS,
  fetchOrdersWindow,
  type AdminGraphqlClient,
  type RawOrder,
} from "./orders";

function makeOrder(id: string): RawOrder {
  return {
    id,
    name: `#${id}`,
    processedAt: "2026-04-01T10:00:00Z",
    presentmentCurrencyCode: "USD",
  };
}

function mockAdmin(pages: Array<{ orders: RawOrder[]; nextCursor: string | null; available?: number }>): AdminGraphqlClient {
  let call = 0;
  return {
    graphql: vi.fn(async () => {
      const page = pages[call++];
      if (!page) throw new Error(`unexpected page request ${call}`);
      return {
        json: async () => ({
          data: {
            orders: {
              pageInfo: {
                hasNextPage: page.nextCursor !== null,
                endCursor: page.nextCursor,
              },
              edges: page.orders.map((o, i) => ({
                cursor: `cur-${call}-${i}`,
                node: o,
              })),
            },
          },
          extensions: {
            cost: {
              throttleStatus: {
                currentlyAvailable: page.available ?? 1000,
                maximumAvailable: 2000,
                restoreRate: 100,
              },
            },
          },
        }),
      };
    }),
  };
}

describe("buildOrdersQuery", () => {
  it("builds processed_at:>=YYYY-MM-DD for the look-back window", () => {
    const now = new Date("2026-04-29T12:00:00Z");
    expect(buildOrdersQuery({ lookbackDays: 60, now })).toBe(
      "processed_at:>=2026-02-28",
    );
  });

  it("clamps to the day boundary regardless of time-of-day", () => {
    const now = new Date("2026-04-29T23:59:59Z");
    expect(buildOrdersQuery({ lookbackDays: 1, now })).toBe(
      "processed_at:>=2026-04-28",
    );
  });
});

describe("fetchOrdersWindow", () => {
  it("paginates with cursor until hasNextPage is false", async () => {
    const admin = mockAdmin([
      { orders: [makeOrder("1"), makeOrder("2")], nextCursor: "cur-1" },
      { orders: [makeOrder("3")], nextCursor: null },
    ]);
    const result = await fetchOrdersWindow(admin, {
      lookbackDays: 30,
      sleep: async () => {},
    });
    expect(result.orders.map((o) => o.id)).toEqual(["1", "2", "3"]);
    expect(result.pagesFetched).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.throttleSleeps).toBe(0);
  });

  it("stops at maxOrders and reports truncated", async () => {
    const admin = mockAdmin([
      { orders: [makeOrder("1"), makeOrder("2"), makeOrder("3")], nextCursor: "cur-1" },
    ]);
    const result = await fetchOrdersWindow(admin, {
      maxOrders: 2,
      pageSize: 3,
      sleep: async () => {},
    });
    expect(result.orders).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("sleeps when throttle headroom drops below the threshold (rate-limit defense)", async () => {
    const sleep = vi.fn(async () => {});
    const admin = mockAdmin([
      { orders: [makeOrder("1")], nextCursor: "cur-1", available: 100 },
      { orders: [makeOrder("2")], nextCursor: null, available: 1000 },
    ]);
    const result = await fetchOrdersWindow(admin, { sleep });
    expect(result.throttleSleeps).toBe(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("propagates GraphQL errors instead of returning an empty list", async () => {
    const admin: AdminGraphqlClient = {
      graphql: async () => ({
        json: async () => ({
          errors: [{ message: "ACCESS_DENIED: read_orders missing" }],
        }),
      }),
    };
    await expect(fetchOrdersWindow(admin, { sleep: async () => {} })).rejects.toThrow(
      /read_orders missing/,
    );
  });

  it("clamps lookbackDays to the 60-day ceiling", async () => {
    const admin = mockAdmin([{ orders: [], nextCursor: null }]);
    let capturedQuery = "";
    const wrapped: AdminGraphqlClient = {
      graphql: async (q, opts) => {
        capturedQuery = String(opts?.variables?.query ?? "");
        return admin.graphql(q, opts);
      },
    };
    const now = new Date("2026-04-29T00:00:00Z");
    await fetchOrdersWindow(wrapped, {
      lookbackDays: 365, // caller asks for a year — we must cap at 60
      sleep: async () => {},
      now: () => now,
    });
    expect(capturedQuery).toBe("processed_at:>=2026-02-28");
    expect(DEFAULT_LOOKBACK_DAYS).toBe(60);
  });
});
