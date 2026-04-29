/**
 * Slice 7 — shared UI polish helpers.
 *
 * Centralises the drift-severity → Polaris-tone mapping, risk-grade pill
 * tones, and a couple of small formatters so every route renders these
 * consistently. No new dependencies — all of this is built on Polaris and
 * the existing typed unions from the diff/audit modules.
 *
 * Honesty rule: every helper here renders a value we *actually compute*
 * (e.g. high/medium/low/unknown grade counts). We don't manufacture
 * aggregate "0–100" scores.
 */

import { Badge, type BadgeProps } from "@shopify/polaris";
import type { ReactNode } from "react";
import type { DriftSeverity } from "../audit/diff-engine";
import type { RiskGrade } from "../audit/risk-scorer";

export function severityTone(
  severity: DriftSeverity,
): NonNullable<BadgeProps["tone"]> {
  switch (severity) {
    case "critical":
      return "critical";
    case "warning":
      return "warning";
    case "info":
      return "info";
  }
}

export function riskGradeTone(grade: RiskGrade): BadgeProps["tone"] {
  switch (grade) {
    case "high":
      return "critical";
    case "medium":
      return "warning";
    case "low":
      return "success";
    case "unknown":
      return "info";
  }
}

export function severityBadge(severity: DriftSeverity): ReactNode {
  return <Badge tone={severityTone(severity)}>{severity.toUpperCase()}</Badge>;
}

export function riskGradeBadge(grade: RiskGrade): ReactNode {
  return <Badge tone={riskGradeTone(grade)}>{grade.toUpperCase()}</Badge>;
}

/**
 * Compose a one-line summary of the merchant's risk profile using ONLY
 * counts we actually computed. Used in dashboard cards + PDF executive
 * summary. Avoids fabricated aggregate scores.
 */
export function riskCountsLine(counts: {
  highRisk: number;
  mediumRisk: number;
  lowRisk: number;
  unknownRisk: number;
}): string {
  return `${counts.highRisk} high-risk · ${counts.mediumRisk} medium · ${counts.lowRisk} low · ${counts.unknownRisk} needs review`;
}

/**
 * Compose the drift-summary one-liner the dashboard renders alongside the
 * latest run.
 */
export function driftCountsLine(stats: {
  critical: number;
  warning: number;
  info: number;
  match: number;
  missing: number;
}): string {
  return `${stats.critical} critical · ${stats.warning} warning · ${stats.info} info · ${stats.match} match · ${stats.missing} untested`;
}

/** Format an ISO timestamp as "YYYY-MM-DD" for tight UI rows. */
export function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  return iso.slice(0, 10);
}

/** Render a clean monetary value with the presentment currency. */
export function fmtMoney(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}
