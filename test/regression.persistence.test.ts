import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import db from "../app/db.server";
import {
  finishRegressionRun,
  listAlertsForRun,
  listRegressionRuns,
  markAlertsDispatched,
  persistDriftAlerts,
  startRegressionRun,
} from "../app/lib/regression/store.server";
import { runRegressionForShop } from "../app/lib/regression/runner.server";

/**
 * Slice 7 round-trip — RegressionRun + DriftAlert lifecycle, plus an
 * end-to-end test of `runRegressionForShop` reading real Slice 3 baselines
 * and Slice 5 outputs out of Prisma. Uses a unique shop per file so the
 * suite stays parallel-safe.
 */

const SHOP = `regression-test-${Math.random().toString(36).slice(2, 10)}.myshopify.com`;

beforeAll(async () => {
  await db.shop.upsert({
    where: { myshopifyDomain: SHOP },
    update: {},
    create: { myshopifyDomain: SHOP, isPlus: true, isDevelopment: true },
  });
});

beforeEach(async () => {
  await db.driftAlert.deleteMany({ where: { shopDomain: SHOP } });
  await db.regressionRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.driftResult.deleteMany({ where: { shopDomain: SHOP } });
  await db.driftRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.functionOutput.deleteMany({ where: { shopDomain: SHOP } });
  await db.captureRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.fixtureBaseline.deleteMany({
    where: { fixture: { shopDomain: SHOP } },
  });
  await db.cartFixture.deleteMany({ where: { shopDomain: SHOP } });
});

afterAll(async () => {
  await db.driftAlert.deleteMany({ where: { shopDomain: SHOP } });
  await db.regressionRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.driftResult.deleteMany({ where: { shopDomain: SHOP } });
  await db.driftRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.functionOutput.deleteMany({ where: { shopDomain: SHOP } });
  await db.captureRun.deleteMany({ where: { shopDomain: SHOP } });
  await db.fixtureBaseline.deleteMany({
    where: { fixture: { shopDomain: SHOP } },
  });
  await db.cartFixture.deleteMany({ where: { shopDomain: SHOP } });
  await db.shop.deleteMany({ where: { myshopifyDomain: SHOP } });
  await db.$disconnect();
});

async function seedFixtureWithBaseline(
  signature: string,
  baseline: { discount: number; shipping: number | null; cartTotal: number },
) {
  const fixture = await db.cartFixture.create({
    data: {
      shopDomain: SHOP,
      signature,
      lineItems: "[]",
      presentmentCurrency: "USD",
      firstObservedAt: new Date("2026-04-01"),
      lastObservedAt: new Date("2026-04-15"),
    },
  });
  await db.fixtureBaseline.create({
    data: {
      fixtureId: fixture.id,
      totalDiscountAmount: baseline.discount,
      shippingRateCode: baseline.shipping !== null ? "STANDARD" : null,
      shippingRateAmount: baseline.shipping,
      cartTotal: baseline.cartTotal,
      capturedAt: new Date("2026-04-15"),
    },
  });
  return fixture.id;
}

async function seedFunctionOutput(
  signature: string,
  observed: { discount: number; cartTotal: number; orderId: string },
) {
  const run = await db.captureRun.create({
    data: {
      shopDomain: SHOP,
      windowFromAt: new Date("2026-04-20"),
      windowToAt: new Date("2026-04-29"),
      status: "completed",
    },
  });
  await db.functionOutput.create({
    data: {
      shopDomain: SHOP,
      captureRunId: run.id,
      sourceOrderGid: observed.orderId,
      fixtureSignature: signature,
      observedDiscountAmount: observed.discount,
      observedShippingCode: "STANDARD",
      observedShippingAmount: 10,
      cartTotal: observed.cartTotal,
      presentmentCurrency: "USD",
      capturedAt: new Date("2026-04-25"),
    },
  });
}

describe("RegressionRun lifecycle", () => {
  it("startRegressionRun creates a running row, finishRegressionRun completes it with denormalised counts", async () => {
    const run = await startRegressionRun(SHOP, "manual");
    let runs = await listRegressionRuns(SHOP);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("running");
    expect(runs[0].trigger).toBe("manual");

    await finishRegressionRun(run.id, {
      driftRunId: "fake-drift-id",
      fixturesExamined: 4,
      matchCount: 1,
      driftCount: 3,
      criticalCount: 1,
      warningCount: 2,
      newCriticalCount: 1,
      newWarningCount: 1,
    });
    runs = await listRegressionRuns(SHOP);
    expect(runs[0].status).toBe("completed");
    expect(runs[0].driftCount).toBe(3);
    expect(runs[0].newCriticalCount).toBe(1);
    expect(runs[0].newWarningCount).toBe(1);
  });

  it("persistDriftAlerts + listAlertsForRun + markAlertsDispatched roundtrip", async () => {
    const run = await startRegressionRun(SHOP, "cron");
    const inserted = await persistDriftAlerts([
      {
        shopDomain: SHOP,
        regressionRunId: run.id,
        fixtureSignature: "fix-A",
        severity: "critical",
        previousSeverity: "warning",
        summary: "Discount delta 12.00 USD",
      },
      {
        shopDomain: SHOP,
        regressionRunId: run.id,
        fixtureSignature: "fix-B",
        severity: "warning",
        previousSeverity: "none",
        summary: "Shipping code changed",
      },
    ]);
    expect(inserted).toBe(2);

    const alerts = await listAlertsForRun(SHOP, run.id);
    expect(alerts).toHaveLength(2);
    // Critical alerts come first regardless of insertion order.
    expect(alerts[0].severity).toBe("critical");
    expect(alerts[0].fixtureSignature).toBe("fix-A");
    expect(alerts[1].severity).toBe("warning");
    expect(alerts.every((a) => a.dispatchedAt === null)).toBe(true);

    await markAlertsDispatched(alerts.map((a) => a.id));
    const after = await listAlertsForRun(SHOP, run.id);
    expect(after.every((a) => a.dispatchedAt instanceof Date)).toBe(true);
  });

  it("persistDriftAlerts is a no-op for empty input (cron with zero alerts shouldn't throw)", async () => {
    const run = await startRegressionRun(SHOP, "cron");
    const count = await persistDriftAlerts([]);
    expect(count).toBe(0);
    expect(await listAlertsForRun(SHOP, run.id)).toEqual([]);
  });
});

describe("runRegressionForShop end-to-end", () => {
  it("emits a DriftAlert for a fixture whose severity escalates from no-prior-run to critical", async () => {
    // Baseline says discount $10; Function output says $0 — that's a critical
    // drop on a $50 cart (>$1 absolute, >10% relative).
    await seedFixtureWithBaseline("fix-1", { discount: 10, shipping: 5, cartTotal: 50 });
    await seedFunctionOutput("fix-1", {
      discount: 0,
      cartTotal: 50,
      orderId: "gid://shopify/Order/1",
    });

    const outcome = await runRegressionForShop(SHOP, "manual");
    expect(outcome.stats.critical).toBe(1);
    expect(outcome.stats.newCritical).toBe(1);
    expect(outcome.alerts).toHaveLength(1);
    expect(outcome.alerts[0].severity).toBe("critical");
    expect(outcome.alerts[0].previousSeverity).toBe("none");

    const persisted = await listAlertsForRun(SHOP, outcome.regressionRunId);
    expect(persisted).toHaveLength(1);
    expect(persisted[0].fixtureSignature).toBe("fix-1");
  });

  it("does NOT re-emit an alert for a fixture that was already critical in the previous run", async () => {
    await seedFixtureWithBaseline("fix-2", { discount: 10, shipping: 5, cartTotal: 50 });
    await seedFunctionOutput("fix-2", {
      discount: 0,
      cartTotal: 50,
      orderId: "gid://shopify/Order/A",
    });

    const first = await runRegressionForShop(SHOP, "manual");
    expect(first.alerts).toHaveLength(1);

    const second = await runRegressionForShop(SHOP, "manual");
    // Second run sees the same critical drift but it's not NEW.
    expect(second.stats.critical).toBe(1);
    expect(second.stats.newCritical).toBe(0);
    expect(second.alerts).toHaveLength(0);
  });
});
