/**
 * Slice 7 — Persistence boundary for Drift Monitor.
 *
 * Owns RegressionRun + DriftAlert. The runner module orchestrates capture +
 * diff + alert detection and uses this module to persist results. The
 * dashboard route reads via these helpers; the cron endpoint writes via
 * the runner.
 *
 * Like Slice 4/5/6 stores, all Prisma access for the regression entities
 * lives here so the rest of the app talks to typed shapes only.
 */
import db from "../../db.server";

export type RegressionTrigger = "cron" | "manual";
export type RegressionStatus = "pending" | "running" | "completed" | "failed";

export interface RegressionRunSummary {
  id: string;
  shopDomain: string;
  trigger: RegressionTrigger;
  driftRunId: string | null;
  status: RegressionStatus;
  startedAt: Date;
  finishedAt: Date | null;
  fixturesExamined: number;
  matchCount: number;
  driftCount: number;
  criticalCount: number;
  warningCount: number;
  newCriticalCount: number;
  newWarningCount: number;
  errorMessage: string | null;
}

export interface DriftAlertRecord {
  id: string;
  shopDomain: string;
  regressionRunId: string;
  fixtureSignature: string;
  severity: "critical" | "warning";
  previousSeverity: "critical" | "warning" | "info" | "none";
  summary: string;
  dispatchedAt: Date | null;
  createdAt: Date;
}

export async function startRegressionRun(
  shopDomain: string,
  trigger: RegressionTrigger,
): Promise<{ id: string }> {
  const run = await db.regressionRun.create({
    data: { shopDomain, trigger, status: "running" },
    select: { id: true },
  });
  return run;
}

export async function failRegressionRun(
  id: string,
  errorMessage: string,
): Promise<void> {
  await db.regressionRun.update({
    where: { id },
    data: {
      status: "failed",
      finishedAt: new Date(),
      errorMessage,
    },
  });
}

export interface RegressionFinishStats {
  driftRunId: string;
  fixturesExamined: number;
  matchCount: number;
  driftCount: number;
  criticalCount: number;
  warningCount: number;
  newCriticalCount: number;
  newWarningCount: number;
}

export async function finishRegressionRun(
  id: string,
  stats: RegressionFinishStats,
): Promise<void> {
  await db.regressionRun.update({
    where: { id },
    data: {
      status: "completed",
      finishedAt: new Date(),
      ...stats,
    },
  });
}

export interface PersistDriftAlertInput {
  shopDomain: string;
  regressionRunId: string;
  fixtureSignature: string;
  severity: "critical" | "warning";
  previousSeverity: "critical" | "warning" | "info" | "none";
  summary: string;
}

export async function persistDriftAlerts(
  alerts: ReadonlyArray<PersistDriftAlertInput>,
): Promise<number> {
  if (alerts.length === 0) return 0;
  const result = await db.driftAlert.createMany({
    data: alerts.map((a) => ({
      shopDomain: a.shopDomain,
      regressionRunId: a.regressionRunId,
      fixtureSignature: a.fixtureSignature,
      severity: a.severity,
      previousSeverity: a.previousSeverity,
      summary: a.summary,
    })),
  });
  return result.count;
}

export async function markAlertsDispatched(
  ids: ReadonlyArray<string>,
): Promise<void> {
  if (ids.length === 0) return;
  await db.driftAlert.updateMany({
    where: { id: { in: [...ids] } },
    data: { dispatchedAt: new Date() },
  });
}

export async function listRegressionRuns(
  shopDomain: string,
  options: { limit?: number } = {},
): Promise<RegressionRunSummary[]> {
  const rows = await db.regressionRun.findMany({
    where: { shopDomain },
    orderBy: { startedAt: "desc" },
    take: options.limit ?? 60,
  });
  return rows.map(toRunSummary);
}

export async function listAlertsForRun(
  shopDomain: string,
  regressionRunId: string,
): Promise<DriftAlertRecord[]> {
  const rows = await db.driftAlert.findMany({
    where: { shopDomain, regressionRunId },
    orderBy: [{ severity: "asc" }, { fixtureSignature: "asc" }],
  });
  // Re-sort by our severity rank (critical first) instead of alphabetic.
  const order: Record<string, number> = { critical: 0, warning: 1 };
  return rows.map(toAlertRecord).sort((a, b) => {
    const oa = order[a.severity] ?? 99;
    const ob = order[b.severity] ?? 99;
    if (oa !== ob) return oa - ob;
    return a.fixtureSignature.localeCompare(b.fixtureSignature);
  });
}

interface DbRegressionRun {
  id: string;
  shopDomain: string;
  trigger: string;
  driftRunId: string | null;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  fixturesExamined: number;
  matchCount: number;
  driftCount: number;
  criticalCount: number;
  warningCount: number;
  newCriticalCount: number;
  newWarningCount: number;
  errorMessage: string | null;
}

function toRunSummary(row: DbRegressionRun): RegressionRunSummary {
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    trigger: row.trigger === "manual" ? "manual" : "cron",
    driftRunId: row.driftRunId,
    status: (row.status as RegressionStatus) ?? "pending",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    fixturesExamined: row.fixturesExamined,
    matchCount: row.matchCount,
    driftCount: row.driftCount,
    criticalCount: row.criticalCount,
    warningCount: row.warningCount,
    newCriticalCount: row.newCriticalCount,
    newWarningCount: row.newWarningCount,
    errorMessage: row.errorMessage,
  };
}

interface DbDriftAlert {
  id: string;
  shopDomain: string;
  regressionRunId: string;
  fixtureSignature: string;
  severity: string;
  previousSeverity: string;
  summary: string;
  dispatchedAt: Date | null;
  createdAt: Date;
}

function toAlertRecord(row: DbDriftAlert): DriftAlertRecord {
  const severity = row.severity === "critical" ? "critical" : "warning";
  const prev = (
    row.previousSeverity === "critical" ||
    row.previousSeverity === "warning" ||
    row.previousSeverity === "info"
      ? row.previousSeverity
      : "none"
  ) as DriftAlertRecord["previousSeverity"];
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    regressionRunId: row.regressionRunId,
    fixtureSignature: row.fixtureSignature,
    severity,
    previousSeverity: prev,
    summary: row.summary,
    dispatchedAt: row.dispatchedAt,
    createdAt: row.createdAt,
  };
}
