/**
 * Migration Risk audit scorer.
 *
 * Pure function. Takes the merchant's discovered Scripts (with classifier
 * output) plus the cart-fixture library (with captured baselines) and
 * produces the structured snapshot that drives the PDF deliverable.
 *
 * Why a snapshot and not direct PDF? See `prisma/schema.prisma` AuditReport:
 * we freeze the data and re-render the PDF on demand so re-downloads stay
 * stable across template tweaks.
 *
 * The scorer is deliberately conservative: when in doubt, push toward
 * `unknown` rather than over-claiming a "low risk" rating. The audit is the
 * deliverable that justifies the $199 / $499 charge — false confidence is the
 * bigger refund risk.
 */

import type { ClassificationCategory } from "../classifier/script-classifier";
import type { DriftResult } from "./diff-engine";

export const RISK_GRADES = ["high", "medium", "low", "unknown"] as const;
export type RiskGrade = (typeof RISK_GRADES)[number];

export interface ScorerScript {
  id: string;
  title: string;
  scriptType: string;
  source: string;
  isActive: boolean;
  classification: {
    autoCategory: ClassificationCategory;
    autoConfidence: number;
    autoSignals: string[];
    overrideCategory: ClassificationCategory | null;
  };
}

export interface ScorerFixture {
  id: string;
  signature: string;
  presentmentCurrency: string;
  shippingCountryCode: string | null;
  customerTags: string[];
  marketSignature: string;
  observationCount: number;
  cartTotal: number;
  baseline: {
    totalDiscountAmount: number;
    discountApplications: Array<{ type?: string; code?: string | null }>;
    shippingRateCode: string | null;
    shippingRateAmount: number | null;
    paymentGatewayNames: string[];
  } | null;
}

export interface ScorerInput {
  shopName: string;
  shopDomain: string;
  /** Slice 1 plan snapshot — for display only. */
  planDisplayName: string | null;
  scripts: ScorerScript[];
  fixtures: ScorerFixture[];
  /** "single" → single-Script-family audit ($199); "multi" → all families ($499). */
  scope: "single" | "multi";
  /** ISO instant. The renderer uses this verbatim — no re-clocking. */
  generatedAt: string;
  /**
   * Slice 6 — optional drift summary. When present, the audit snapshot's
   * `drift` field is populated and the PDF renders the Drift Alerts section.
   * When omitted (e.g. legacy audit re-runs), `drift` is null.
   */
  drift?: {
    generatedAt: string;
    examined: number;
    matched: number;
    missing: number;
    drift: number;
    critical: number;
    warning: number;
    info: number;
    alerts: DriftResult[];
    missingSignatures: string[];
  };
}

export interface ScoredScript {
  id: string;
  title: string;
  effectiveCategory: ClassificationCategory;
  isClassifierConfident: boolean;
  /** Heuristic 0-100 complexity score. Drives the PDF "complexity" column. */
  complexity: number;
  riskGrade: RiskGrade;
  riskReasons: string[];
  /** Brief description of what the script appears to do, for the per-script section. */
  summary: string;
  /** Edge cases observed in the fixture corpus that this script likely affects. */
  edgeCases: string[];
}

export interface ScoredFixture {
  id: string;
  summary: string;
  baselineNotes: string[];
  /** "things that could go wrong in migration" annotations. */
  migrationRisks: string[];
}

export interface ChecklistItem {
  /** 1-based ranking. Lower = higher revenue impact. */
  rank: number;
  title: string;
  detail: string;
  /** Which Script id this checklist row is anchored to (or null for cross-cutting). */
  scriptId: string | null;
  riskGrade: RiskGrade;
}

export interface OpenQuestion {
  id: string;
  question: string;
  /** Optional Script id this question is asked against. */
  scriptId: string | null;
}

export interface AuditSnapshot {
  schemaVersion: 1;
  shopName: string;
  shopDomain: string;
  planDisplayName: string | null;
  scope: "single" | "multi";
  generatedAt: string;
  counts: {
    scripts: number;
    activeScripts: number;
    fixtures: number;
    highRisk: number;
    mediumRisk: number;
    lowRisk: number;
    unknownRisk: number;
  };
  topRisks: Array<{ scriptId: string; title: string; grade: RiskGrade; reason: string }>;
  scripts: ScoredScript[];
  fixtures: ScoredFixture[];
  checklist: ChecklistItem[];
  openQuestions: OpenQuestion[];
  /**
   * Slice 6 — drift summary. Optional so older AuditReport rows (snapshotted
   * before drift integration) hydrate cleanly. Null means "drift wasn't run
   * for this report"; an empty `results` array with non-zero `examined`
   * means "drift ran and everything matched."
   */
  drift: AuditDriftSummary | null;
}

export interface AuditDriftSummary {
  generatedAt: string;
  examined: number;
  matched: number;
  missing: number;
  drift: number;
  critical: number;
  warning: number;
  info: number;
  /** Top 25 alerts ranked by severity (critical → info) for the PDF. */
  alerts: DriftResult[];
  /** Fixture signatures with no captured Function output yet. */
  missingSignatures: string[];
}

const HIGH_RISK_PATTERNS = [
  /customer&?\.tags\b/,
  /customer&?\.tax_exempt\b/,
  /customer&?\.b2b\?/,
  /\bcart\.market\b/,
  /\bpresentment_currency\b/,
];
const MEDIUM_RISK_PATTERNS = [
  /\bshipping_rates\.delete_if\b/,
  /\bpayment_gateways\.delete_if\b/,
  /Money\.new\(\s*cents:/,
  /tier_/,
  /threshold/i,
];

/**
 * 0-100 complexity heuristic. Counts conditional density, control flow, and
 * external state references. Used as a proxy for "how hard is this Script to
 * port to a Function" — not as a ground-truth metric.
 */
export function complexityScore(source: string): number {
  if (!source) return 0;
  const lines = source.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  const conditionals = countMatches(source, /\b(?:if|elsif|unless|case|when|while|until)\b/g);
  const customerRefs = countMatches(source, /customer&?\./g);
  const cartRefs = countMatches(source, /\bcart\.[a-z]/g);
  const marketRefs = countMatches(source, /(?:presentment_currency|cart\.market|country_code)/g);
  const raw =
    Math.min(lines, 80) * 0.5 +
    conditionals * 4 +
    customerRefs * 3 +
    cartRefs * 1 +
    marketRefs * 5;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function countMatches(source: string, re: RegExp): number {
  let m: RegExpExecArray | null;
  let count = 0;
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  while ((m = r.exec(source))) {
    count++;
    if (m.index === r.lastIndex) r.lastIndex++;
  }
  return count;
}

function effectiveCategory(s: ScorerScript): ClassificationCategory {
  return s.classification.overrideCategory ?? s.classification.autoCategory;
}

function gradeForScript(s: ScorerScript, fixtures: ScorerFixture[]): {
  grade: RiskGrade;
  reasons: string[];
} {
  const reasons: string[] = [];
  const cat = effectiveCategory(s);
  const complexity = complexityScore(s.source);

  let highHits = 0;
  let mediumHits = 0;
  for (const re of HIGH_RISK_PATTERNS) if (re.test(s.source)) highHits++;
  for (const re of MEDIUM_RISK_PATTERNS) if (re.test(s.source)) mediumHits++;

  if (cat === "b2b" || cat === "market_pricing") {
    reasons.push(`Classification "${cat}" — depends on per-customer or per-market state.`);
  }
  if (highHits > 0) {
    reasons.push(`${highHits} high-risk reference(s) (customer tags, tax-exempt, market, or presentment currency).`);
  }
  if (mediumHits > 0) {
    reasons.push(`${mediumHits} medium-risk reference(s) (shipping/payment gateway manipulation, tiered thresholds).`);
  }
  if (complexity >= 60) {
    reasons.push(`High complexity score (${complexity}/100) — many conditional branches.`);
  }
  if (s.classification.overrideCategory === null && s.classification.autoConfidence < 0.6) {
    reasons.push("Classifier confidence below 0.6 — review the category before trusting this audit.");
  }
  if (!s.isActive) {
    reasons.push("Script is archived. Risk only matters if you reactivate it.");
  }

  // Promote to high if the script touches customer state, market, OR is marked
  // b2b/market_pricing categories. Otherwise grade by complexity bands.
  let grade: RiskGrade = "unknown";
  if (highHits > 0 || cat === "b2b" || cat === "market_pricing") {
    grade = "high";
  } else if (mediumHits > 0 || cat === "shipping" || cat === "payment" || complexity >= 50) {
    grade = "medium";
  } else if (cat === "discount" && complexity < 30) {
    grade = "low";
  } else if (cat === "discount") {
    grade = "medium";
  } else {
    grade = "unknown";
  }
  if (!s.isActive && grade !== "unknown") {
    // Archived scripts don't affect production until reactivated; demote one band.
    grade = grade === "high" ? "medium" : grade === "medium" ? "low" : "unknown";
  }
  // Edge case: tiny corpus with no fixtures means we can't observe edge cases.
  if (fixtures.length === 0) {
    reasons.push(
      "No cart fixtures generated yet. Risk grade is preliminary; re-run after fixtures land.",
    );
    if (grade === "low") grade = "unknown";
  }

  return { grade, reasons };
}

function categoryLabel(cat: ClassificationCategory): string {
  switch (cat) {
    case "discount":
      return "Discount logic";
    case "shipping":
      return "Shipping rule";
    case "payment":
      return "Payment customization";
    case "market_pricing":
      return "Market pricing";
    case "b2b":
      return "B2B logic";
    case "other":
      return "Other / Needs review";
  }
}

function summariseScript(s: ScorerScript): string {
  const cat = effectiveCategory(s);
  const c = complexityScore(s.source);
  return `${categoryLabel(cat)}. Complexity ${c}/100. ${s.scriptType.replace("_", " ")} script.`;
}

function edgeCasesForCategory(
  cat: ClassificationCategory,
  fixtures: ScorerFixture[],
): string[] {
  const out: string[] = [];
  if (cat === "market_pricing" || cat === "b2b") {
    const currencies = new Set(fixtures.map((f) => f.presentmentCurrency));
    const countries = new Set(
      fixtures.map((f) => f.shippingCountryCode).filter(Boolean) as string[],
    );
    if (currencies.size > 1) out.push(`${currencies.size} presentment currencies observed: ${[...currencies].join(", ")}.`);
    if (countries.size > 1) out.push(`${countries.size} shipping countries observed: ${[...countries].sort().join(", ")}.`);
    const taggedFixtures = fixtures.filter((f) => f.customerTags.length > 0);
    if (taggedFixtures.length > 0) {
      const tags = new Set<string>();
      for (const f of taggedFixtures) for (const t of f.customerTags) tags.add(t);
      out.push(`Customer tags appearing across fixtures: ${[...tags].sort().join(", ")}.`);
    }
  }
  if (cat === "shipping") {
    const rates = new Set(fixtures.map((f) => f.baseline?.shippingRateCode).filter(Boolean) as string[]);
    if (rates.size > 0) out.push(`Shipping rate codes seen: ${[...rates].sort().join(", ")}.`);
  }
  if (cat === "payment") {
    const gateways = new Set<string>();
    for (const f of fixtures) for (const g of f.baseline?.paymentGatewayNames ?? []) gateways.add(g);
    if (gateways.size > 0) out.push(`Payment gateways used: ${[...gateways].sort().join(", ")}.`);
  }
  if (cat === "discount") {
    const codes = new Set<string>();
    for (const f of fixtures)
      for (const d of f.baseline?.discountApplications ?? [])
        if (d.code && d.code !== "[redacted]") codes.add(d.code);
    if (codes.size > 0) out.push(`Discount codes observed in last 60 days: ${[...codes].slice(0, 8).join(", ")}.`);
  }
  return out;
}

function annotateFixture(f: ScorerFixture): ScoredFixture {
  const baselineNotes: string[] = [];
  const migrationRisks: string[] = [];
  if (f.baseline) {
    if (f.baseline.totalDiscountAmount > 0) {
      baselineNotes.push(
        `Discount of ${f.baseline.totalDiscountAmount.toFixed(2)} ${f.presentmentCurrency} applied historically.`,
      );
      migrationRisks.push("Verify the new Function reproduces this discount on the same cart.");
    }
    if (f.baseline.shippingRateAmount !== null) {
      baselineNotes.push(
        `Shipping rate "${f.baseline.shippingRateCode ?? "unknown"}" charged at ${f.baseline.shippingRateAmount.toFixed(2)} ${f.presentmentCurrency}.`,
      );
    }
    if (f.baseline.paymentGatewayNames.length > 0) {
      baselineNotes.push(`Paid via: ${f.baseline.paymentGatewayNames.join(", ")}.`);
    }
  }
  if (f.customerTags.length > 0) {
    migrationRisks.push(
      `Customer tags ${f.customerTags.join(", ")} likely gate behavior — ensure the Function reads them.`,
    );
  }
  if ((f.shippingCountryCode ?? "??") !== "??") {
    migrationRisks.push(
      `Shipping country ${f.shippingCountryCode} — confirm market/region rules trigger as expected.`,
    );
  }
  if (f.observationCount >= 5) {
    migrationRisks.push(
      `${f.observationCount} historical orders match this composition — high-volume scenario, prioritize testing.`,
    );
  }
  return {
    id: f.id,
    summary: `${f.presentmentCurrency} cart, ${f.shippingCountryCode ?? "no country"}, ${f.observationCount} order${f.observationCount === 1 ? "" : "s"}`,
    baselineNotes,
    migrationRisks,
  };
}

function buildChecklist(scoredScripts: ScoredScript[]): ChecklistItem[] {
  // Order: high → medium → low → unknown. Stable rank by classifier confidence
  // tie-breaker so the same input → same output (PDF stability).
  const order: Record<RiskGrade, number> = { high: 0, medium: 1, low: 2, unknown: 3 };
  const sorted = [...scoredScripts].sort((a, b) => {
    if (order[a.riskGrade] !== order[b.riskGrade]) return order[a.riskGrade] - order[b.riskGrade];
    if (a.complexity !== b.complexity) return b.complexity - a.complexity;
    return a.title.localeCompare(b.title);
  });
  return sorted.map((s, idx) => ({
    rank: idx + 1,
    title: `Validate ${categoryLabel(s.effectiveCategory)} parity for "${s.title}"`,
    detail:
      s.riskReasons.length > 0
        ? s.riskReasons[0]
        : "Run cart fixtures through the new Function and confirm matching outputs.",
    scriptId: s.id,
    riskGrade: s.riskGrade,
  }));
}

function buildOpenQuestions(scripts: ScorerScript[], fixtures: ScorerFixture[]): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  let n = 0;
  for (const s of scripts) {
    const cat = effectiveCategory(s);
    if (cat === "other" || (s.classification.overrideCategory === null && s.classification.autoConfidence < 0.6)) {
      out.push({
        id: `q-${++n}`,
        scriptId: s.id,
        question: `What does "${s.title}" actually do? The classifier wasn't confident; we need a one-line answer to anchor the audit.`,
      });
    }
    if (/customer&?\.metafields\b/.test(s.source)) {
      out.push({
        id: `q-${++n}`,
        scriptId: s.id,
        question: `"${s.title}" reads customer metafields — confirm which keys are required so the new Function has access.`,
      });
    }
  }
  if (fixtures.length === 0) {
    out.push({
      id: `q-${++n}`,
      scriptId: null,
      question:
        "No cart fixtures were generated. Was the order history empty in the last 60 days, or did Generate Fixtures fail? The audit cannot anchor on real edge cases without them.",
    });
  } else if (fixtures.length < 5) {
    out.push({
      id: `q-${++n}`,
      scriptId: null,
      question: `Only ${fixtures.length} representative cart fixtures emerged from the order history. Are there expected scenarios not covered (e.g. B2B carts, multi-market, BFCM) that we should add manually before audit?`,
    });
  }
  return out;
}

export function buildAuditSnapshot(input: ScorerInput): AuditSnapshot {
  const scoredScripts: ScoredScript[] = input.scripts.map((s) => {
    const { grade, reasons } = gradeForScript(s, input.fixtures);
    const cat = effectiveCategory(s);
    return {
      id: s.id,
      title: s.title,
      effectiveCategory: cat,
      isClassifierConfident:
        s.classification.overrideCategory !== null || s.classification.autoConfidence >= 0.6,
      complexity: complexityScore(s.source),
      riskGrade: grade,
      riskReasons: reasons,
      summary: summariseScript(s),
      edgeCases: edgeCasesForCategory(cat, input.fixtures),
    };
  });

  const scoredFixtures = input.fixtures.map(annotateFixture);

  const counts = {
    scripts: scoredScripts.length,
    activeScripts: input.scripts.filter((s) => s.isActive).length,
    fixtures: scoredFixtures.length,
    highRisk: scoredScripts.filter((s) => s.riskGrade === "high").length,
    mediumRisk: scoredScripts.filter((s) => s.riskGrade === "medium").length,
    lowRisk: scoredScripts.filter((s) => s.riskGrade === "low").length,
    unknownRisk: scoredScripts.filter((s) => s.riskGrade === "unknown").length,
  };

  const topRisks = [...scoredScripts]
    .filter((s) => s.riskGrade === "high")
    .slice(0, 3)
    .map((s) => ({
      scriptId: s.id,
      title: s.title,
      grade: s.riskGrade,
      reason: s.riskReasons[0] ?? "High-risk classification",
    }));

  return {
    schemaVersion: 1 as const,
    shopName: input.shopName,
    shopDomain: input.shopDomain,
    planDisplayName: input.planDisplayName,
    scope: input.scope,
    generatedAt: input.generatedAt,
    counts,
    topRisks,
    scripts: scoredScripts,
    fixtures: scoredFixtures,
    checklist: buildChecklist(scoredScripts),
    openQuestions: buildOpenQuestions(input.scripts, input.fixtures),
    drift: input.drift
      ? {
          generatedAt: input.drift.generatedAt,
          examined: input.drift.examined,
          matched: input.drift.matched,
          missing: input.drift.missing,
          drift: input.drift.drift,
          critical: input.drift.critical,
          warning: input.drift.warning,
          info: input.drift.info,
          // Cap at 25 alerts in the snapshot — the PDF can't usefully render
          // more, and the full set lives in the DriftRun rows.
          alerts: input.drift.alerts.slice(0, 25),
          missingSignatures: input.drift.missingSignatures.slice(0, 50),
        }
      : null,
  };
}
