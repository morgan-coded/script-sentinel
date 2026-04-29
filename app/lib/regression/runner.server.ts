/**
 * Slice 7 — Continuous Regression runner.
 *
 * Wraps the Slice 6 diff engine in a "did anything get worse since last
 * time?" loop. One execution does:
 *   1. Run the Slice 6 diff (creates a new DriftRun + DriftResult rows).
 *   2. Compare per-fixture severity to the PREVIOUS DriftRun for the shop.
 *      Any fixture whose severity escalated (none→info→warning→critical)
 *      becomes a DriftAlert row on this RegressionRun.
 *   3. Persist the RegressionRun summary.
 *
 * Capture refresh (re-pulling recent orders into FunctionOutput rows) is
 * intentionally NOT in the cron path. That step needs an authenticated
 * Shopify admin client; the cron handler can opt-in via `captureFn` if
 * wired up by the deployer with offline tokens. The diff itself runs purely
 * against persisted Prisma rows and is the load-bearing recurring value.
 *
 * Alert detection is a pure function (`detectEscalations`) so it can be
 * tested without touching the database.
 */
import db from "../../db.server";
import { runDriftAndPersist } from "../audit/diff-runner.server";
import {
  finishRegressionRun,
  failRegressionRun,
  persistDriftAlerts,
  startRegressionRun,
  type PersistDriftAlertInput,
  type RegressionTrigger,
} from "./store.server";

export type AlertSeverity = "critical" | "warning";
export type ResultSeverity = AlertSeverity | "info";
export type PreviousSeverity = ResultSeverity | "none";

const SEVERITY_RANK: Record<PreviousSeverity, number> = {
  none: 0,
  info: 1,
  warning: 2,
  critical: 3,
};

export interface FixtureSeveritySnapshot {
  fixtureSignature: string;
  severity: ResultSeverity;
  /** First-line summary of the underlying drift; carried into the alert row. */
  summary: string;
}

export interface EscalationInput {
  current: ReadonlyArray<FixtureSeveritySnapshot>;
  previous: ReadonlyArray<{
    fixtureSignature: string;
    severity: ResultSeverity;
  }>;
}

export interface Escalation {
  fixtureSignature: string;
  severity: AlertSeverity;
  previousSeverity: PreviousSeverity;
  summary: string;
}

/**
 * Pure: returns the list of fixtures whose severity escalated, restricted to
 * critical / warning end states. info-level alerts are not emailed (too
 * noisy) — they still land on DriftRun for the dashboard.
 *
 * Re-emitted alerts: if a fixture stayed at the same severity (e.g. critical
 * yesterday, critical today), no new alert. Only escalations.
 */
export function detectEscalations(input: EscalationInput): Escalation[] {
  const previousBySig = new Map<string, ResultSeverity>();
  for (const p of input.previous) previousBySig.set(p.fixtureSignature, p.severity);
  const out: Escalation[] = [];
  for (const c of input.current) {
    if (c.severity !== "critical" && c.severity !== "warning") continue;
    const prev = previousBySig.get(c.fixtureSignature) ?? "none";
    if (SEVERITY_RANK[c.severity] > SEVERITY_RANK[prev]) {
      out.push({
        fixtureSignature: c.fixtureSignature,
        severity: c.severity,
        previousSeverity: prev,
        summary: c.summary,
      });
    }
  }
  return out.sort((a, b) => {
    const ra = SEVERITY_RANK[a.severity];
    const rb = SEVERITY_RANK[b.severity];
    if (ra !== rb) return rb - ra;
    return a.fixtureSignature.localeCompare(b.fixtureSignature);
  });
}

/**
 * Pull the previous-run severity snapshot for a shop. Returns the most recent
 * DriftRun's per-fixture severity (or [] if no prior run). Drift run rows
 * themselves cascade through DriftResult only for drift-emitting fixtures —
 * matches and missing are NOT in DriftResult, so they always count as
 * "previously: none" for escalation purposes. That's the desired behaviour:
 * a fixture going from match → critical IS an escalation worth alerting.
 */
async function loadPreviousSnapshot(
  shopDomain: string,
  excludeDriftRunId: string,
): Promise<Array<{ fixtureSignature: string; severity: ResultSeverity }>> {
  const previousRun = await db.driftRun.findFirst({
    where: { shopDomain, status: "completed", id: { not: excludeDriftRunId } },
    orderBy: { startedAt: "desc" },
  });
  if (!previousRun) return [];
  const rows = await db.driftResult.findMany({
    where: { shopDomain, driftRunId: previousRun.id },
    select: { fixtureSignature: true, severity: true },
  });
  return rows.map((r) => ({
    fixtureSignature: r.fixtureSignature,
    severity:
      r.severity === "critical" || r.severity === "warning" ? r.severity : "info",
  }));
}

export interface RegressionOutcome {
  regressionRunId: string;
  driftRunId: string;
  alerts: Escalation[];
  stats: {
    fixturesExamined: number;
    match: number;
    drift: number;
    critical: number;
    warning: number;
    info: number;
    newCritical: number;
    newWarning: number;
  };
}

/**
 * Run one regression for a shop. Re-runs the diff, detects escalations,
 * persists the summary + alerts. Surfaces the outcome so the cron handler
 * can render emails for the new alerts.
 */
export async function runRegressionForShop(
  shopDomain: string,
  trigger: RegressionTrigger,
): Promise<RegressionOutcome> {
  const run = await startRegressionRun(shopDomain, trigger);
  try {
    const diff = await runDriftAndPersist(shopDomain);

    const previous = await loadPreviousSnapshot(shopDomain, diff.driftRunId);
    const current: FixtureSeveritySnapshot[] = diff.diff.results.map((r) => ({
      fixtureSignature: r.fixtureSignature,
      severity:
        r.severity === "critical" || r.severity === "warning" ? r.severity : "info",
      summary: r.message,
    }));
    const escalations = detectEscalations({ current, previous });

    const alertsToPersist: PersistDriftAlertInput[] = escalations.map((e) => ({
      shopDomain,
      regressionRunId: run.id,
      fixtureSignature: e.fixtureSignature,
      severity: e.severity,
      previousSeverity: e.previousSeverity,
      summary: e.summary,
    }));
    await persistDriftAlerts(alertsToPersist);

    const newCritical = escalations.filter((e) => e.severity === "critical").length;
    const newWarning = escalations.filter((e) => e.severity === "warning").length;

    await finishRegressionRun(run.id, {
      driftRunId: diff.driftRunId,
      fixturesExamined: diff.diff.stats.fixturesExamined,
      matchCount: diff.diff.stats.match,
      driftCount: diff.diff.stats.drift,
      criticalCount: diff.diff.stats.critical,
      warningCount: diff.diff.stats.warning,
      newCriticalCount: newCritical,
      newWarningCount: newWarning,
    });

    return {
      regressionRunId: run.id,
      driftRunId: diff.driftRunId,
      alerts: escalations,
      stats: {
        fixturesExamined: diff.diff.stats.fixturesExamined,
        match: diff.diff.stats.match,
        drift: diff.diff.stats.drift,
        critical: diff.diff.stats.critical,
        warning: diff.diff.stats.warning,
        info: diff.diff.stats.info,
        newCritical,
        newWarning,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failRegressionRun(run.id, message);
    throw err;
  }
}
