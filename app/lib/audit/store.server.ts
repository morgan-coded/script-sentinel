/**
 * Audit persistence layer — Prisma boundary for AuditPurchase and AuditReport.
 *
 * The audit module keeps the structured snapshot as the source of truth and re-renders
 * the PDF on every download (see prisma/schema.prisma rationale). This module
 * is the only place the audit code talks to Prisma.
 */
import db from "../../db.server";
import { BILLING_PRODUCTS } from "../billing/products";
import {
  type AuditPlanKey,
  scopeForPlan,
} from "../billing/charge.server";
import type { AuditSnapshot } from "./risk-scorer";
import type {
  DiffEngineResult,
  DriftResult,
  DriftSeverity,
  DriftCategory,
} from "./diff-engine";

const TWELVE_MONTHS_MS = 1000 * 60 * 60 * 24 * 365;

export interface SavedReport {
  id: string;
  shopDomain: string;
  scope: "single" | "multi";
  scriptCount: number;
  fixtureCount: number;
  highRiskCount: number;
  generatedAt: Date;
  filename: string;
  snapshot: AuditSnapshot;
}

/**
 * Mark an audit purchase as ACTIVE after Shopify confirms the charge. Sets
 * the 12-month re-download window. Idempotent on `shopifyChargeGid`: if the
 * charge has already been recorded, we simply update status/activatedAt.
 */
export async function recordActivePurchase(
  shopDomain: string,
  options: {
    plan: AuditPlanKey;
    shopifyChargeGid: string;
    isTest: boolean;
  },
): Promise<{ id: string }> {
  const product = BILLING_PRODUCTS[options.plan];
  const now = new Date();
  const existing = await db.auditPurchase.findUnique({
    where: { shopifyChargeGid: options.shopifyChargeGid },
  });
  if (existing) {
    if (existing.status === "active") return { id: existing.id };
    const updated = await db.auditPurchase.update({
      where: { id: existing.id },
      data: {
        status: "active",
        activatedAt: now,
        expiresAt: new Date(now.getTime() + TWELVE_MONTHS_MS),
      },
    });
    return { id: updated.id };
  }
  const created = await db.auditPurchase.create({
    data: {
      shopDomain,
      planKey: options.plan,
      amount: product.amount,
      currencyCode: product.currencyCode,
      shopifyChargeGid: options.shopifyChargeGid,
      isTest: options.isTest,
      status: "active",
      activatedAt: now,
      expiresAt: new Date(now.getTime() + TWELVE_MONTHS_MS),
    },
  });
  return { id: created.id };
}

/** Most recent active audit purchase for the shop, or null. */
export async function getActivePurchase(shopDomain: string) {
  return db.auditPurchase.findFirst({
    where: { shopDomain, status: "active" },
    orderBy: { activatedAt: "desc" },
  });
}

export async function saveAuditReport(options: {
  shopDomain: string;
  purchaseId: string;
  snapshot: AuditSnapshot;
}): Promise<SavedReport> {
  const filename = `script-sentinel-audit-${options.shopDomain}-${options.snapshot.generatedAt.slice(0, 10)}.pdf`;
  const row = await db.auditReport.create({
    data: {
      shopDomain: options.shopDomain,
      purchaseId: options.purchaseId,
      scope: scopeForPlan(getPurchasePlan(options.snapshot)),
      snapshot: JSON.stringify(options.snapshot),
      scriptCount: options.snapshot.counts.scripts,
      fixtureCount: options.snapshot.counts.fixtures,
      highRiskCount: options.snapshot.counts.highRisk,
      filename,
    },
  });
  return hydrate(row);
}

function getPurchasePlan(snapshot: AuditSnapshot): AuditPlanKey {
  return snapshot.scope === "multi" ? "MULTI_SCRIPT_AUDIT" : "MIGRATION_RISK_AUDIT";
}

export async function listReports(shopDomain: string): Promise<SavedReport[]> {
  const rows = await db.auditReport.findMany({
    where: { shopDomain },
    orderBy: { generatedAt: "desc" },
  });
  return rows.map(hydrate);
}

export async function getReport(
  shopDomain: string,
  id: string,
): Promise<SavedReport | null> {
  const row = await db.auditReport.findFirst({
    where: { id, shopDomain },
  });
  return row ? hydrate(row) : null;
}

interface DbReport {
  id: string;
  shopDomain: string;
  scope: string;
  snapshot: string;
  scriptCount: number;
  fixtureCount: number;
  highRiskCount: number;
  generatedAt: Date;
  filename: string;
}

function hydrate(row: DbReport): SavedReport {
  let snapshot: AuditSnapshot;
  try {
    snapshot = JSON.parse(row.snapshot) as AuditSnapshot;
  } catch {
    // Corrupt rows shouldn't crash the route; render an empty placeholder
    // snapshot so the merchant gets feedback rather than a 500.
    snapshot = {
      schemaVersion: 1,
      shopName: "(snapshot unavailable)",
      shopDomain: row.shopDomain,
      planDisplayName: null,
      scope: row.scope === "multi" ? "multi" : "single",
      generatedAt: row.generatedAt.toISOString(),
      counts: {
        scripts: 0,
        activeScripts: 0,
        fixtures: 0,
        highRisk: 0,
        mediumRisk: 0,
        lowRisk: 0,
        unknownRisk: 0,
      },
      topRisks: [],
      scripts: [],
      fixtures: [],
      checklist: [],
      openQuestions: [],
      drift: null,
    };
  }
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    scope: row.scope === "multi" ? "multi" : "single",
    scriptCount: row.scriptCount,
    fixtureCount: row.fixtureCount,
    highRiskCount: row.highRiskCount,
    generatedAt: row.generatedAt,
    filename: row.filename,
    snapshot,
  };
}

// ---------------------------------------------------------------------------
// DriftRun + DriftResult persistence.
//
// The diff engine (`./diff-engine.ts`) is pure. This module is the only
// place those results meet Prisma. Re-runs create a new DriftRun row; older
// runs stay readable so the route can show drift trend over time.
// ---------------------------------------------------------------------------

export interface DriftRunSummary {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  status: "pending" | "running" | "completed" | "failed";
  fixturesExamined: number;
  matchCount: number;
  missingCount: number;
  driftCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  errorMessage: string | null;
}

export interface StoredDriftResult extends DriftResult {
  id: string;
  driftRunId: string;
  createdAt: Date;
}

export async function startDriftRun(shopDomain: string): Promise<{ id: string }> {
  const run = await db.driftRun.create({
    data: {
      shopDomain,
      status: "running",
    },
    select: { id: true },
  });
  return run;
}

/**
 * Persist the diff engine result against an existing DriftRun. Stores one
 * DriftResult row per emitted alert; counts are denormalised onto the parent
 * DriftRun for fast list rendering.
 */
export async function recordDriftResults(
  shopDomain: string,
  driftRunId: string,
  diff: DiffEngineResult,
): Promise<void> {
  if (diff.results.length > 0) {
    await db.driftResult.createMany({
      data: diff.results.map((r) => ({
        shopDomain,
        driftRunId,
        fixtureSignature: r.fixtureSignature,
        severity: r.severity,
        categories: JSON.stringify(r.categories),
        message: r.message,
        recommendation: r.recommendation,
        baselineSummary: JSON.stringify(r.baseline),
        outputSummary: JSON.stringify(r.output),
      })),
    });
  }
  await db.driftRun.update({
    where: { id: driftRunId },
    data: {
      finishedAt: new Date(),
      status: "completed",
      fixturesExamined: diff.stats.fixturesExamined,
      matchCount: diff.stats.match,
      missingCount: diff.stats.missing,
      driftCount: diff.stats.drift,
      criticalCount: diff.stats.critical,
      warningCount: diff.stats.warning,
      infoCount: diff.stats.info,
    },
  });
}

export async function failDriftRun(driftRunId: string, errorMessage: string): Promise<void> {
  await db.driftRun.update({
    where: { id: driftRunId },
    data: {
      status: "failed",
      finishedAt: new Date(),
      errorMessage,
    },
  });
}

export async function listDriftRuns(shopDomain: string): Promise<DriftRunSummary[]> {
  const rows = await db.driftRun.findMany({
    where: { shopDomain },
    orderBy: { startedAt: "desc" },
    take: 25,
  });
  return rows.map((row) => ({
    id: row.id,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    status: (row.status as DriftRunSummary["status"]) ?? "pending",
    fixturesExamined: row.fixturesExamined,
    matchCount: row.matchCount,
    missingCount: row.missingCount,
    driftCount: row.driftCount,
    criticalCount: row.criticalCount,
    warningCount: row.warningCount,
    infoCount: row.infoCount,
    errorMessage: row.errorMessage,
  }));
}

export async function listDriftResultsForRun(
  shopDomain: string,
  driftRunId: string,
): Promise<StoredDriftResult[]> {
  const rows = await db.driftResult.findMany({
    where: { shopDomain, driftRunId },
    orderBy: [
      { severity: "asc" }, // alphabetic; we sort properly below
      { fixtureSignature: "asc" },
    ],
  });
  // Re-sort by our severity rank rather than the alphabetic Prisma sort.
  const order: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  return rows
    .map(rowToStoredResult)
    .sort((a, b) => {
      const oa = order[a.severity] ?? 99;
      const ob = order[b.severity] ?? 99;
      if (oa !== ob) return oa - ob;
      return a.fixtureSignature.localeCompare(b.fixtureSignature);
    });
}

export async function getLatestDriftRun(
  shopDomain: string,
): Promise<{ run: DriftRunSummary; results: StoredDriftResult[] } | null> {
  const runs = await listDriftRuns(shopDomain);
  if (runs.length === 0) return null;
  const latest = runs[0];
  const results = await listDriftResultsForRun(shopDomain, latest.id);
  return { run: latest, results };
}

interface DbDriftResultRow {
  id: string;
  shopDomain: string;
  driftRunId: string;
  fixtureSignature: string;
  severity: string;
  categories: string;
  message: string;
  recommendation: string;
  baselineSummary: string;
  outputSummary: string;
  createdAt: Date;
}

function rowToStoredResult(row: DbDriftResultRow): StoredDriftResult {
  let categories: DriftCategory[] = [];
  try {
    const parsed = JSON.parse(row.categories);
    if (Array.isArray(parsed)) categories = parsed.filter(isCategory);
  } catch {
    categories = [];
  }
  return {
    id: row.id,
    driftRunId: row.driftRunId,
    createdAt: row.createdAt,
    fixtureSignature: row.fixtureSignature,
    severity: (isSeverity(row.severity) ? row.severity : "info") as DriftSeverity,
    categories,
    message: row.message,
    recommendation: row.recommendation,
    baseline: parseSummary(row.baselineSummary),
    output: parseSummary(row.outputSummary),
  };
}

function isSeverity(s: string): s is DriftSeverity {
  return s === "critical" || s === "warning" || s === "info";
}

function isCategory(s: unknown): s is DriftCategory {
  return (
    s === "discount" ||
    s === "shipping" ||
    s === "payment" ||
    s === "totals" ||
    // Segment tags persisted alongside behavioural categories.
    s === "b2b" ||
    s === "market"
  );
}

function parseSummary(json: string): DriftResult["baseline"] {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") {
      return {
        totalDiscount: Number(parsed.totalDiscount ?? 0),
        shippingCode: parsed.shippingCode ?? null,
        shippingAmount:
          typeof parsed.shippingAmount === "number" ? parsed.shippingAmount : null,
        paymentGateways: Array.isArray(parsed.paymentGateways)
          ? parsed.paymentGateways.map(String)
          : [],
        cartTotal: Number(parsed.cartTotal ?? 0),
        presentmentCurrency: String(parsed.presentmentCurrency ?? "USD"),
      };
    }
  } catch {
    // fall through
  }
  return {
    totalDiscount: 0,
    shippingCode: null,
    shippingAmount: null,
    paymentGateways: [],
    cartTotal: 0,
    presentmentCurrency: "USD",
  };
}
