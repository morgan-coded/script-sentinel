/**
 * Slice 6 — server-side helper that joins the diff engine to Prisma.
 *
 * Two callers:
 *   1. `/app/drift` route — when the merchant clicks "Run diff"
 *   2. `/app/audit` generate action — runs diff before saving the snapshot
 *      so the PDF includes the Drift Alerts section.
 *
 * Both call sites share the same lifecycle (start run → compute → persist
 * results → finalize counts) so this helper centralizes it.
 */
import db from "../../db.server";
import {
  runDiff,
  type DiffEngineResult,
} from "./diff-engine";
import {
  failDriftRun,
  recordDriftResults,
  startDriftRun,
} from "./store.server";

export interface DiffRunOutcome {
  driftRunId: string;
  diff: DiffEngineResult;
}

/**
 * Pull the shop's CartFixture+FixtureBaseline rows (Slice 3) and
 * FunctionOutput rows (Slice 5), run the diff engine, persist the results
 * against a fresh DriftRun.
 *
 * Throws on Prisma errors. Diff itself is pure; if it ever throws the
 * helper marks the run as failed before re-raising.
 */
export async function runDriftAndPersist(shopDomain: string): Promise<DiffRunOutcome> {
  const fixtureRows = await db.cartFixture.findMany({
    where: { shopDomain },
    include: { baseline: true },
  });
  const outputRows = await db.functionOutput.findMany({
    where: { shopDomain },
    orderBy: { capturedAt: "desc" },
  });

  const baselines = fixtureRows
    .filter((f) => f.baseline !== null)
    .map((f) => ({
      fixtureSignature: f.signature,
      totalDiscountAmount: f.baseline?.totalDiscountAmount ?? 0,
      shippingRateCode: f.baseline?.shippingRateCode ?? null,
      shippingRateAmount: f.baseline?.shippingRateAmount ?? null,
      paymentGatewayNames: safeJsonArray(f.baseline?.paymentGatewayNames ?? "[]"),
      cartTotal: f.baseline?.cartTotal ?? 0,
      presentmentCurrency: f.presentmentCurrency,
    }));

  const outputs = outputRows.map((o) => ({
    fixtureSignature: o.fixtureSignature,
    observedDiscountAmount: o.observedDiscountAmount,
    observedShippingCode: o.observedShippingCode,
    observedShippingAmount: o.observedShippingAmount,
    observedPaymentGateways: safeJsonArray(o.observedPaymentGateways),
    cartTotal: o.cartTotal,
    presentmentCurrency: o.presentmentCurrency,
  }));

  const run = await startDriftRun(shopDomain);
  try {
    const diff = runDiff({ baselines, outputs });
    await recordDriftResults(shopDomain, run.id, diff);
    return { driftRunId: run.id, diff };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failDriftRun(run.id, message);
    throw err;
  }
}

function safeJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
