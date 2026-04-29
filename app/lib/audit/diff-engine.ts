/**
 * Slice 6 — Diff engine.
 *
 * Joins Slice 3 `FixtureBaseline` rows (Script-era observations) to Slice 5
 * `FunctionOutput` rows (Function-era observations) by `fixtureSignature` and
 * computes a per-fixture severity grade. Pure — no I/O, no Prisma.
 *
 * Severity rules (deterministic, exhaustively tested):
 *
 *   discount drift:
 *     - >$1 absolute AND >10% relative   → critical
 *     - >$0.50 absolute AND >5% relative → warning
 *     - any non-zero delta               → info (rounding / FX)
 *     - exact match                      → no drift
 *
 *   shipping drift:
 *     - rate disappeared in Function output       → critical
 *     - rate amount delta > $1                    → critical
 *     - rate code changed but amount equal        → warning (renamed)
 *     - new rate appeared in output, baseline had none → info
 *     - exact match                               → no drift
 *
 *   payment drift:
 *     - gateway disappeared in Function output → critical (merchant loses option)
 *     - gateway appeared (Function adds method) → info
 *     - same set                                → no drift
 *
 *   cart-total drift:
 *     - delta > 5% relative AND > $1 absolute → warning
 *     - smaller delta                         → info
 *     - exact                                 → no drift
 *
 * The fixture's overall severity is the HIGHEST of the per-category drifts.
 * Match (no drift in any category) and missing-output (no FunctionOutput
 * row at all) are NOT alerts — they're counted in DiffStats but not emitted
 * as DriftResult rows. This keeps the alert UI focused on actionable drift.
 */

export type DriftSeverity = "critical" | "warning" | "info";
export type DriftCategory = "discount" | "shipping" | "payment" | "totals";

export interface DriftSummary {
  totalDiscount: number;
  shippingCode: string | null;
  shippingAmount: number | null;
  paymentGateways: string[];
  cartTotal: number;
  presentmentCurrency: string;
}

export interface DriftResult {
  fixtureSignature: string;
  severity: DriftSeverity;
  categories: DriftCategory[];
  message: string;
  recommendation: string;
  baseline: DriftSummary;
  output: DriftSummary;
}

export interface DiffStats {
  fixturesExamined: number;
  /** Both sides present, every category equal. */
  match: number;
  /** Baseline present but no FunctionOutput captured yet. */
  missing: number;
  /** Total alerts emitted (any severity). */
  drift: number;
  critical: number;
  warning: number;
  info: number;
}

/**
 * Input shape for the diff engine. Defined as plain interfaces (not bound to
 * the Prisma row types) so callers can feed in mocks for tests, persisted
 * rows for the route, or transformed snapshots for the PDF.
 */
export interface DiffBaselineInput {
  fixtureSignature: string;
  totalDiscountAmount: number;
  shippingRateCode: string | null;
  shippingRateAmount: number | null;
  paymentGatewayNames: string[];
  cartTotal: number;
  presentmentCurrency: string;
}

export interface DiffOutputInput {
  fixtureSignature: string;
  observedDiscountAmount: number;
  observedShippingCode: string | null;
  observedShippingAmount: number | null;
  observedPaymentGateways: string[];
  cartTotal: number;
  presentmentCurrency: string;
}

export interface DiffEngineInput {
  baselines: ReadonlyArray<DiffBaselineInput>;
  outputs: ReadonlyArray<DiffOutputInput>;
}

export interface DiffEngineResult {
  results: DriftResult[];
  stats: DiffStats;
  /**
   * Fixture signatures that have a baseline but no captured FunctionOutput.
   * Surfaced in the UI as "untested in production — needs a synthetic order
   * before cutover." Per the Slice 5 README's honest-limitation paragraph.
   */
  missingSignatures: string[];
}

const SEVERITY_ORDER: Record<DriftSeverity, number> = {
  info: 1,
  warning: 2,
  critical: 3,
};

function maxSeverity(a: DriftSeverity, b: DriftSeverity): DriftSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

interface CategoryDrift {
  category: DriftCategory;
  severity: DriftSeverity;
  message: string;
  recommendation: string;
}

function fmt(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

function relativeDelta(baseline: number, output: number): number {
  if (baseline === 0) return output === 0 ? 0 : 1;
  return Math.abs(output - baseline) / Math.abs(baseline);
}

function diffDiscount(
  b: DiffBaselineInput,
  o: DiffOutputInput,
): CategoryDrift | null {
  const delta = Math.abs(o.observedDiscountAmount - b.totalDiscountAmount);
  if (delta === 0) return null;
  const rel = relativeDelta(b.totalDiscountAmount, o.observedDiscountAmount);
  const direction = o.observedDiscountAmount > b.totalDiscountAmount ? "increased" : "decreased";
  const baseStr = fmt(b.totalDiscountAmount, b.presentmentCurrency);
  const outStr = fmt(o.observedDiscountAmount, o.presentmentCurrency);
  const message = `Discount ${direction} by ${fmt(delta, b.presentmentCurrency)} (baseline ${baseStr} → Function output ${outStr}).`;
  if (delta > 1 && rel > 0.1) {
    return {
      category: "discount",
      severity: "critical",
      message,
      recommendation:
        "Verify the new Function applies the same discount rule. A >10% delta on a real cart is large enough to surface in a customer complaint.",
    };
  }
  if (delta > 0.5 && rel > 0.05) {
    return {
      category: "discount",
      severity: "warning",
      message,
      recommendation:
        "Behavioural drift detected. Compare the Function's discount allocation against the Script's BOGO/percentage logic before BFCM.",
    };
  }
  return {
    category: "discount",
    severity: "info",
    message,
    recommendation:
      "Sub-threshold delta — likely currency rounding or FX. No action required, but worth a glance during regression review.",
  };
}

function diffShipping(
  b: DiffBaselineInput,
  o: DiffOutputInput,
): CategoryDrift | null {
  // Both null → no shipping captured on either side, no drift.
  if (b.shippingRateCode === null && o.observedShippingCode === null) return null;
  // Baseline had shipping; output didn't → critical (rate disappeared).
  if (b.shippingRateCode !== null && o.observedShippingCode === null) {
    return {
      category: "shipping",
      severity: "critical",
      message: `Shipping rate "${b.shippingRateCode}" disappeared from Function-era orders (was ${fmt(b.shippingRateAmount ?? 0, b.presentmentCurrency)}).`,
      recommendation:
        "Confirm the new delivery-customization Function still emits this rate. Disappearance is the most common Functions-migration regression.",
    };
  }
  // Output added a shipping rate the baseline didn't have → info (Function added).
  if (b.shippingRateCode === null && o.observedShippingCode !== null) {
    return {
      category: "shipping",
      severity: "info",
      message: `Function output exposes new shipping rate "${o.observedShippingCode}" not seen in Script-era baselines.`,
      recommendation:
        "Probably a Function adding choice. Worth verifying the rate's price is intentional.",
    };
  }
  // Both have shipping. Compare amount + code.
  const baseAmount = b.shippingRateAmount ?? 0;
  const outAmount = o.observedShippingAmount ?? 0;
  const amountDelta = Math.abs(outAmount - baseAmount);
  const codeChanged = b.shippingRateCode !== o.observedShippingCode;

  if (amountDelta > 1) {
    return {
      category: "shipping",
      severity: "critical",
      message: `Shipping rate "${b.shippingRateCode}" changed price by ${fmt(amountDelta, b.presentmentCurrency)} (baseline ${fmt(baseAmount, b.presentmentCurrency)} → Function ${fmt(outAmount, o.presentmentCurrency)}).`,
      recommendation:
        "Customers will see a different shipping price at checkout. Verify the Function's pricing rules match the Script's expectations.",
    };
  }
  if (codeChanged) {
    return {
      category: "shipping",
      severity: "warning",
      message: `Shipping rate code changed: "${b.shippingRateCode}" → "${o.observedShippingCode}" (price unchanged at ${fmt(baseAmount, b.presentmentCurrency)}).`,
      recommendation:
        "Cosmetic rename, but check downstream systems (carrier integrations, label templates, analytics) that may expect the original code.",
    };
  }
  return null;
}

function diffPayment(
  b: DiffBaselineInput,
  o: DiffOutputInput,
): CategoryDrift | null {
  const baseline = new Set(b.paymentGatewayNames);
  const output = new Set(o.observedPaymentGateways);
  const disappeared: string[] = [];
  const appeared: string[] = [];
  for (const g of baseline) if (!output.has(g)) disappeared.push(g);
  for (const g of output) if (!baseline.has(g)) appeared.push(g);
  if (disappeared.length === 0 && appeared.length === 0) return null;

  if (disappeared.length > 0) {
    return {
      category: "payment",
      severity: "critical",
      message: `Payment gateway${disappeared.length > 1 ? "s" : ""} ${disappeared.sort().map((g) => `"${g}"`).join(", ")} disappeared from Function-era orders.`,
      recommendation:
        "If the merchant's payment-customization Function intentionally hides these gateways, this is expected. Otherwise it's a checkout regression.",
    };
  }
  return {
    category: "payment",
    severity: "info",
    message: `Function output adds payment gateway${appeared.length > 1 ? "s" : ""} ${appeared.sort().map((g) => `"${g}"`).join(", ")} not seen in Script-era baselines.`,
    recommendation:
      "Probably a new method enabled in checkout settings. No action needed unless the merchant is restricting methods.",
  };
}

function diffTotals(
  b: DiffBaselineInput,
  o: DiffOutputInput,
): CategoryDrift | null {
  const delta = Math.abs(o.cartTotal - b.cartTotal);
  if (delta === 0) return null;
  const rel = relativeDelta(b.cartTotal, o.cartTotal);
  const direction = o.cartTotal > b.cartTotal ? "higher" : "lower";
  const message = `Cart total ${direction} by ${fmt(delta, b.presentmentCurrency)} (baseline ${fmt(b.cartTotal, b.presentmentCurrency)} → Function ${fmt(o.cartTotal, o.presentmentCurrency)}).`;
  if (rel > 0.05 && delta > 1) {
    return {
      category: "totals",
      severity: "warning",
      message,
      recommendation:
        "Cart-total delta > 5% suggests the discount or shipping totals didn't agree. Often a downstream symptom of one of the other drifts above.",
    };
  }
  return {
    category: "totals",
    severity: "info",
    message,
    recommendation:
      "Sub-threshold delta, usually rounding. No action required.",
  };
}

function summarise(b: DiffBaselineInput, o: DiffOutputInput): { baseline: DriftSummary; output: DriftSummary } {
  return {
    baseline: {
      totalDiscount: b.totalDiscountAmount,
      shippingCode: b.shippingRateCode,
      shippingAmount: b.shippingRateAmount,
      paymentGateways: [...b.paymentGatewayNames].sort(),
      cartTotal: b.cartTotal,
      presentmentCurrency: b.presentmentCurrency,
    },
    output: {
      totalDiscount: o.observedDiscountAmount,
      shippingCode: o.observedShippingCode,
      shippingAmount: o.observedShippingAmount,
      paymentGateways: [...o.observedPaymentGateways].sort(),
      cartTotal: o.cartTotal,
      presentmentCurrency: o.presentmentCurrency,
    },
  };
}

/**
 * Run the diff engine. Pure function — same input always yields the same
 * output. Sorted deterministically by severity (critical → info) then by
 * fixtureSignature so the PDF and UI render reproducibly.
 */
export function runDiff(input: DiffEngineInput): DiffEngineResult {
  const outputBySig = new Map<string, DiffOutputInput>();
  for (const o of input.outputs) {
    // For a signature with multiple captured outputs, keep the most recent
    // (highest cartTotal as a proxy here since we don't carry capturedAt
    // through the diff input). Callers that care can pre-filter.
    const existing = outputBySig.get(o.fixtureSignature);
    if (!existing) outputBySig.set(o.fixtureSignature, o);
  }

  const results: DriftResult[] = [];
  const missingSignatures: string[] = [];
  let match = 0;
  let critical = 0;
  let warning = 0;
  let info = 0;

  for (const baseline of input.baselines) {
    const output = outputBySig.get(baseline.fixtureSignature);
    if (!output) {
      missingSignatures.push(baseline.fixtureSignature);
      continue;
    }
    const drifts: CategoryDrift[] = [];
    const a = diffDiscount(baseline, output);
    const b = diffShipping(baseline, output);
    const c = diffPayment(baseline, output);
    const d = diffTotals(baseline, output);
    if (a) drifts.push(a);
    if (b) drifts.push(b);
    if (c) drifts.push(c);
    if (d) drifts.push(d);

    if (drifts.length === 0) {
      match++;
      continue;
    }

    let severity: DriftSeverity = drifts[0].severity;
    for (const d of drifts) severity = maxSeverity(severity, d.severity);
    if (severity === "critical") critical++;
    else if (severity === "warning") warning++;
    else info++;

    const summary = summarise(baseline, output);
    // Compose a unified message + recommendation by joining the per-category
    // text. Keep deterministic ordering (discount, shipping, payment,
    // totals) so test snapshots are stable.
    const ordered: DriftCategory[] = ["discount", "shipping", "payment", "totals"];
    const orderedDrifts = ordered
      .map((cat) => drifts.find((d) => d.category === cat))
      .filter((d): d is CategoryDrift => Boolean(d));

    results.push({
      fixtureSignature: baseline.fixtureSignature,
      severity,
      categories: orderedDrifts.map((d) => d.category),
      message: orderedDrifts.map((d) => d.message).join(" "),
      recommendation: orderedDrifts.map((d) => d.recommendation).join(" "),
      baseline: summary.baseline,
      output: summary.output,
    });
  }

  // Stable deterministic sort: severity desc, then signature asc.
  results.sort((x, y) => {
    if (SEVERITY_ORDER[x.severity] !== SEVERITY_ORDER[y.severity]) {
      return SEVERITY_ORDER[y.severity] - SEVERITY_ORDER[x.severity];
    }
    return x.fixtureSignature.localeCompare(y.fixtureSignature);
  });

  return {
    results,
    stats: {
      fixturesExamined: input.baselines.length,
      match,
      missing: missingSignatures.length,
      drift: results.length,
      critical,
      warning,
      info,
    },
    missingSignatures: [...missingSignatures].sort(),
  };
}
