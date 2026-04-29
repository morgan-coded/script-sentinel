/**
 * Heuristic Shopify Script classifier.
 *
 * Maps a Ruby Shopify Script source string to one of six categories. Pure —
 * no I/O. Inputs are merchant Ruby code (untrusted text); we never eval it,
 * we just run regex/keyword matches over the source.
 *
 * Slice 2 keeps this purely heuristic. The product roadmap reserves space for
 * an LLM fallback when no heuristic signal is strong enough — see the
 * `LlmClassifier` interface below for that future hook. Slice 2 does NOT make
 * any LLM calls; the stub returns null so callers fall through to "other".
 */

export const CLASSIFICATION_CATEGORIES = [
  "discount",
  "shipping",
  "payment",
  "market_pricing",
  "b2b",
  "other",
] as const;

export type ClassificationCategory = (typeof CLASSIFICATION_CATEGORIES)[number];

/** Display labels for the badge. Kept in this module so a single edit covers UI + tests. */
export const CATEGORY_LABEL: Record<ClassificationCategory, string> = {
  discount: "Discount Logic",
  shipping: "Shipping Rule",
  payment: "Payment Customization",
  market_pricing: "Market Pricing",
  b2b: "B2B Logic",
  other: "Other / Needs Review",
};

export interface ClassificationResult {
  category: ClassificationCategory;
  confidence: number; // 0.0 – 1.0
  signals: string[]; // Names of patterns that matched, for explainability.
}

/**
 * Future hook for an LLM fallback when heuristics return low confidence. Slice
 * 2 does not implement an LLM call; pass null to signal "no LLM available".
 * Defining the interface now keeps the classifier seam clean.
 */
export interface LlmClassifier {
  classify(source: string): Promise<ClassificationResult | null>;
}

/**
 * Pattern bundle. Each entry is one signal (a regex + a name). When a pattern
 * matches anywhere in the source, the corresponding category accumulates 1
 * weighted point. The "weight" lets us emphasize strong, rarely-coincidental
 * markers like `Input.payment_gateways` over weak ones like the bare word
 * "currency" which can show up in many contexts.
 */
type Pattern = { name: string; re: RegExp; weight: number };

// Pattern weights are tuned against the SCRIPT_SAMPLES corpus. The semantic
// rule we encode: a script's *defining* trait wins over the *mechanic* it uses.
// e.g. a script that branches on `presentment_currency` and then calls
// `change_line_price` is a market-pricing script that happens to use the
// discount mechanic — not a discount script.
//
// Cardinal rules to avoid double-counting:
//   - Each unique fingerprint in the source contributes exactly one pattern
//     per category. Don't add overlapping patterns within the same bundle
//     (e.g. `change_line_price` AND `line_item.change_line_price`) or you'll
//     amplify the same code twice.
//   - Cross-bundle overlap is OK — that's how we model "this script touches
//     multiple concerns" and the highest-weight bundle wins.
const DISCOUNT_PATTERNS: Pattern[] = [
  { name: "Discount.new", re: /\bDiscount\.new\b/, weight: 4 },
  { name: "change_line_price", re: /\bchange_line_price\b/, weight: 5 },
  { name: "discount_message", re: /\bdiscount_message\b/, weight: 2 },
  { name: "apply_to(:line_item)", re: /apply_to\(?\s*:line_item/, weight: 3 },
  { name: "PercentageDiscount", re: /\bPercentageDiscount\b/, weight: 5 },
  { name: "MoneyDiscount", re: /\bMoneyDiscount\b/, weight: 5 },
  { name: "cart.line_items.each", re: /cart\.line_items\.each\b/, weight: 1 },
  { name: "Money.new(cents:", re: /Money\.new\(\s*cents:/, weight: 1 },
];

const SHIPPING_PATTERNS: Pattern[] = [
  { name: "Input.shipping_rates", re: /Input\.shipping_rates\b/, weight: 5 },
  { name: "Output.shipping_rates", re: /Output\.shipping_rates\b/, weight: 5 },
  { name: "shipping_rate.apply_discount", re: /shipping_rate\.apply_discount\b/, weight: 3 },
  { name: "shipping_rate.change_name", re: /shipping_rate\.change_name\b/, weight: 3 },
  { name: "shipping_rates.delete_if", re: /shipping_rates\.delete_if\b/, weight: 3 },
  { name: "ShippingDiscount", re: /\bShippingDiscount\b/, weight: 3 },
  { name: "rates_to_remove", re: /\brates_to_remove\b/, weight: 2 },
  { name: "cart.shipping_address.zip", re: /cart\.shipping_address\.zip\b/, weight: 2 },
];

const PAYMENT_PATTERNS: Pattern[] = [
  { name: "Input.payment_gateways", re: /Input\.payment_gateways\b/, weight: 5 },
  { name: "Output.payment_gateways", re: /Output\.payment_gateways\b/, weight: 5 },
  { name: "payment_gateways.delete_if", re: /payment_gateways\.delete_if\b/, weight: 3 },
  { name: "payment_gateways.partition", re: /payment_gateways\.partition\b/, weight: 3 },
  { name: "payment_gateways.sort_by", re: /payment_gateways\.sort_by\b/, weight: 3 },
  { name: "gateway.name", re: /gateway\.name\b/, weight: 2 },
  { name: "PaymentGateway", re: /\bPaymentGateway\b/, weight: 2 },
  { name: "hide_payment_method", re: /\bhide_payment_method\b/, weight: 2 },
];

// Market-pricing weights are deliberately the highest in the catalog because
// the market/currency primitives are unique markers — non-market scripts
// almost never reference `presentment_currency`, `cart.market`, or
// `shipping_address.country_code`. When they appear we want them to dominate
// any line-price manipulation that follows.
const MARKET_PRICING_PATTERNS: Pattern[] = [
  { name: "presentment_currency", re: /\bpresentment_currency\b/, weight: 8 },
  { name: "Input.cart.presentment_currency_rate", re: /Input\.cart\.presentment_currency_rate\b/, weight: 8 },
  { name: "cart.market", re: /\bcart\.market\b/, weight: 8 },
  { name: "market.handle", re: /\bmarket\.handle\b/, weight: 4 },
  { name: "shipping_address.country_code", re: /shipping_address\.country_code\b/, weight: 7 },
  { name: "cart.currency", re: /\bcart\.currency\b/, weight: 3 },
  { name: "country_code in", re: /country_code\b.*\bin\b/, weight: 1 },
];

// `customer&?\.` admits Ruby's safe-navigation operator `customer&.tags` as
// well as the plain `customer.tags`. Real-world checkout scripts almost always
// guard customer reads with safe-nav because the cart may be unauthenticated.
const B2B_PATTERNS: Pattern[] = [
  { name: "customer.b2b?", re: /customer&?\.b2b\?/, weight: 6 },
  // Any `customer.tags.include?(...)` call is a strong B2B hint regardless of
  // the literal value — gating on customer tags is the canonical B2B pattern.
  { name: "customer.tags.include?", re: /customer&?\.tags\.include\?/, weight: 4 },
  { name: "customer.tags include wholesale", re: /customer&?\.tags[^\n]*['"]wholesale['"]/i, weight: 1 },
  { name: "customer.tags include vip", re: /customer&?\.tags[^\n]*['"]vip['"]/i, weight: 1 },
  { name: "customer.tax_exempt", re: /customer&?\.tax_exempt\b/, weight: 6 },
  { name: "customer.company", re: /customer&?\.company\b/, weight: 3 },
  { name: "b2b keyword", re: /\bb2b\b/i, weight: 2 },
  { name: "wholesale keyword", re: /\bwholesale\b/i, weight: 1 },
  { name: "customer.metafields", re: /customer&?\.metafields\b/, weight: 2 },
  // Any reference to customer.tags is a moderate B2B signal — non-B2B scripts
  // rarely read customer tags, so this captures cases where the include? form
  // is replaced with .find / .any? / .select.
  { name: "customer.tags any reference", re: /customer&?\.tags\b/, weight: 6 },
];

const PATTERN_BUNDLES: Record<
  Exclude<ClassificationCategory, "other">,
  Pattern[]
> = {
  discount: DISCOUNT_PATTERNS,
  shipping: SHIPPING_PATTERNS,
  payment: PAYMENT_PATTERNS,
  market_pricing: MARKET_PRICING_PATTERNS,
  b2b: B2B_PATTERNS,
};

/**
 * Confidence threshold below which we return "other / needs review" even if
 * one weak signal matched. Tuned against the test corpus: anything < 3
 * weighted points is too noisy to trust as a primary classification.
 */
const MIN_CONFIDENCE_SCORE = 3;

/**
 * Score the source against every pattern bundle. Returns the per-category
 * matched-signals list and weight totals so callers can introspect.
 */
function scoreCategories(source: string) {
  const scores: Record<string, { weight: number; signals: string[] }> = {};
  for (const [category, patterns] of Object.entries(PATTERN_BUNDLES)) {
    const matched: string[] = [];
    let weight = 0;
    for (const p of patterns) {
      if (p.re.test(source)) {
        matched.push(p.name);
        weight += p.weight;
      }
    }
    scores[category] = { weight, signals: matched };
  }
  return scores;
}

/**
 * Pick the highest-scoring category, breaking ties on alphabetical order to
 * keep the result deterministic. Returns `other` when no category clears
 * `MIN_CONFIDENCE_SCORE`.
 *
 * Confidence is weight / 7 capped at 1.0 — tuned so that a single
 * weight-5 marker (e.g. `change_line_price`, `Input.shipping_rates`) lands
 * just above 0.7 confidence. The UI surfaces a "needs review" hint below 0.6.
 */
export function classifyScript(source: string): ClassificationResult {
  if (!source || source.trim().length === 0) {
    return { category: "other", confidence: 0, signals: [] };
  }

  const scores = scoreCategories(source);
  const ranked = Object.entries(scores)
    .map(([category, { weight, signals }]) => ({ category, weight, signals }))
    .sort((a, b) =>
      b.weight !== a.weight
        ? b.weight - a.weight
        : a.category.localeCompare(b.category),
    );

  const top = ranked[0];

  if (!top || top.weight < MIN_CONFIDENCE_SCORE) {
    // Aggregate any weak signals that did fire, so the UI can still show
    // *something* useful for "Needs Review".
    const weakSignals = ranked.flatMap((r) =>
      r.signals.map((s) => `${r.category}:${s}`),
    );
    return {
      category: "other",
      confidence: top ? Math.min(top.weight / 7, 0.5) : 0,
      signals: weakSignals,
    };
  }

  return {
    category: top.category as ClassificationCategory,
    confidence: Math.min(top.weight / 7, 1),
    signals: top.signals,
  };
}

/**
 * Effective category at read time = override (if set) else auto. Tiny helper
 * that keeps the override semantic in one place so loaders / risk-scoring
 * can't drift.
 */
export function effectiveCategory(
  autoCategory: ClassificationCategory,
  overrideCategory: ClassificationCategory | null,
): ClassificationCategory {
  return overrideCategory ?? autoCategory;
}

/**
 * Type guard for converting a raw DB string (Prisma stores categories as
 * String for SQLite compat) back to the union.
 */
export function asCategory(raw: string | null | undefined): ClassificationCategory | null {
  if (!raw) return null;
  return (CLASSIFICATION_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as ClassificationCategory)
    : null;
}
