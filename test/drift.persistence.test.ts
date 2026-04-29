import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import db from "../app/db.server";
import {
  failDriftRun,
  getLatestDriftRun,
  listDriftResultsForRun,
  listDriftRuns,
  recordDriftResults,
  startDriftRun,
} from "../app/lib/audit/store.server";
import type { DiffEngineResult } from "../app/lib/audit/diff-engine";

/**
 * Slice 6 persistence round-trip — DriftRun lifecycle, result write+read,
 * counts denormalisation. Uses the real Prisma schema (the
 * slice6_diff_engine migration was applied during setup).
 */

const SHOP = `drift-test-${Math.random().toString(36).slice(2, 10)}.myshopify.com`;

beforeAll(async () => {
  await db.shop.upsert({
    where: { myshopifyDomain: SHOP },
    update: {},
    create: { myshopifyDomain: SHOP, isPlus: true, isDevelopment: true },
  });
});

beforeEach(async () => {
  await db.driftResult.deleteMany({ where: { shopDomain: SHOP } });
  await db.driftRun.deleteMany({ where: { shopDomain: SHOP } });
});

afterAll(async () => {
  await db.driftResult.deleteMany({ where: { shopDomain: SHOP } });
  await db.driftRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.shop.deleteMany({ where: { myshopifyDomain: SHOP } });
  await db.$disconnect();
});

function mockDiff(
  overrides: Partial<DiffEngineResult> = {},
): DiffEngineResult {
  return {
    results: [],
    stats: {
      fixturesExamined: 0,
      match: 0,
      missing: 0,
      drift: 0,
      critical: 0,
      warning: 0,
      info: 0,
    },
    missingSignatures: [],
    ...overrides,
  };
}

describe("DriftRun lifecycle", () => {
  it("startDriftRun creates a row in `running` status; recordDriftResults completes it", async () => {
    const run = await startDriftRun(SHOP);
    expect(run.id).toBeTruthy();

    await recordDriftResults(
      SHOP,
      run.id,
      mockDiff({
        results: [
          {
            fixtureSignature: "sig-A",
            severity: "critical",
            categories: ["discount"],
            message: "Discount decreased by 5.00 USD",
            recommendation: "Verify the new Function applies the same rule.",
            baseline: {
              totalDiscount: 10,
              shippingCode: "STANDARD",
              shippingAmount: 10,
              paymentGateways: ["shopify_payments"],
              cartTotal: 100,
              presentmentCurrency: "USD",
            },
            output: {
              totalDiscount: 5,
              shippingCode: "STANDARD",
              shippingAmount: 10,
              paymentGateways: ["shopify_payments"],
              cartTotal: 95,
              presentmentCurrency: "USD",
            },
          },
        ],
        stats: {
          fixturesExamined: 5,
          match: 3,
          missing: 1,
          drift: 1,
          critical: 1,
          warning: 0,
          info: 0,
        },
        missingSignatures: ["sig-untested"],
      }),
    );

    const runs = await listDriftRuns(SHOP);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].fixturesExamined).toBe(5);
    expect(runs[0].criticalCount).toBe(1);
    expect(runs[0].matchCount).toBe(3);
    expect(runs[0].missingCount).toBe(1);
    expect(runs[0].finishedAt).toBeInstanceOf(Date);

    const results = await listDriftResultsForRun(SHOP, run.id);
    expect(results).toHaveLength(1);
    expect(results[0].severity).toBe("critical");
    expect(results[0].categories).toEqual(["discount"]);
    expect(results[0].baseline.totalDiscount).toBe(10);
    expect(results[0].output.totalDiscount).toBe(5);
  });

  it("failDriftRun marks the run failed without persisting results", async () => {
    const run = await startDriftRun(SHOP);
    await failDriftRun(run.id, "boom");
    const runs = await listDriftRuns(SHOP);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].errorMessage).toBe("boom");
    expect(await listDriftResultsForRun(SHOP, run.id)).toEqual([]);
  });

  it("listDriftResultsForRun returns alerts sorted critical → info, then by signature", async () => {
    const run = await startDriftRun(SHOP);
    await recordDriftResults(
      SHOP,
      run.id,
      mockDiff({
        results: [
          {
            fixtureSignature: "z-info",
            severity: "info",
            categories: ["totals"],
            message: "info",
            recommendation: "no action",
            baseline: emptySummary(),
            output: emptySummary(),
          },
          {
            fixtureSignature: "a-info",
            severity: "info",
            categories: ["totals"],
            message: "info",
            recommendation: "no action",
            baseline: emptySummary(),
            output: emptySummary(),
          },
          {
            fixtureSignature: "critical-A",
            severity: "critical",
            categories: ["discount"],
            message: "crit",
            recommendation: "fix",
            baseline: emptySummary(),
            output: emptySummary(),
          },
        ],
        stats: {
          fixturesExamined: 3,
          match: 0,
          missing: 0,
          drift: 3,
          critical: 1,
          warning: 0,
          info: 2,
        },
      }),
    );
    const results = await listDriftResultsForRun(SHOP, run.id);
    expect(results.map((r) => r.fixtureSignature)).toEqual([
      "critical-A",
      "a-info",
      "z-info",
    ]);
  });
});

describe("getLatestDriftRun", () => {
  it("returns the most recent run with its alerts", async () => {
    const r1 = await startDriftRun(SHOP);
    await recordDriftResults(SHOP, r1.id, mockDiff());
    // Force a small delay so startedAt ordering is deterministic.
    await new Promise((r) => setTimeout(r, 10));
    const r2 = await startDriftRun(SHOP);
    await recordDriftResults(
      SHOP,
      r2.id,
      mockDiff({
        results: [
          {
            fixtureSignature: "sig",
            severity: "warning",
            categories: ["shipping"],
            message: "msg",
            recommendation: "rec",
            baseline: emptySummary(),
            output: emptySummary(),
          },
        ],
        stats: {
          fixturesExamined: 1,
          match: 0,
          missing: 0,
          drift: 1,
          critical: 0,
          warning: 1,
          info: 0,
        },
      }),
    );
    const latest = await getLatestDriftRun(SHOP);
    expect(latest?.run.id).toBe(r2.id);
    expect(latest?.results).toHaveLength(1);
    expect(latest?.results[0].severity).toBe("warning");
  });

  it("returns null for a shop with no runs (graceful empty-shop contract)", async () => {
    expect(await getLatestDriftRun(SHOP)).toBeNull();
  });
});

function emptySummary() {
  return {
    totalDiscount: 0,
    shippingCode: null,
    shippingAmount: null,
    paymentGateways: [],
    cartTotal: 0,
    presentmentCurrency: "USD",
  };
}
