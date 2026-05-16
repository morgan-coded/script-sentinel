/**
 * Fixture extractor — turns Shopify Admin orders into deduped CartFixture +
 * FixtureBaseline rows.
 *
 * The extractor is pure (no I/O) so the caller can run it on real Admin API
 * responses or on hand-curated test JSON. The persistence layer
 * (`app/lib/fixtures/store.server.ts`) is a thin wrapper around Prisma.
 *
 * Privacy invariant: this module never carries names, emails, phones, or
 * full addresses past the boundary. The PII scrubber in `./pii.ts` is the
 * only place we permit address fields, and it returns only country code +
 * postal prefix. The persistence test asserts that the JSON-serialised
 * `lineItems` column never contains email-shaped or phone-shaped strings.
 */

import { createHash } from "node:crypto";
import {
  containsLikelyPII,
  scrubAddress,
  scrubCustomerTags,
  tagSignature,
} from "./pii";
import type { RawOrder } from "../shopify/orders";

export interface LineItemSnapshot {
  /** ProductVariant gid. Null for line items where the variant was deleted. */
  variantId: string | null;
  /** Product gid. Null when the line item references a product that's been deleted. */
  productId: string | null;
  /** Variant SKU. Null if the merchant doesn't track SKUs. */
  sku: string | null;
  /** Product/Variant title. Used in fixture display only — never in dedup. */
  title: string;
  /** Cart-line quantity. */
  quantity: number;
  /** Per-unit list price in presentment currency. 0 when unavailable. */
  unitPrice: number;
}

export interface DiscountSnapshot {
  /** "DiscountCodeApplication" / "AutomaticDiscountApplication" / "ManualDiscountApplication" / "ScriptDiscountApplication". */
  type: string;
  /** Discount code if it's a code application. */
  code: string | null;
  /** "ACROSS" / "EACH" — Shopify's allocation method. */
  allocationMethod: string | null;
  /** "LINE_ITEM" / "SHIPPING_LINE". */
  targetType: string | null;
  /** "ALL" / "ENTITLED" / "EXPLICIT". */
  targetSelection: string | null;
  /** Money amount in presentment currency, OR null when value is a percentage. */
  amount: number | null;
  /** Percentage 0-100, OR null when value is a money amount. */
  percentage: number | null;
}

export interface ExtractedFixture {
  signature: string;
  lineItems: LineItemSnapshot[];
  customerTags: string[];
  shippingCountryCode: string | null;
  shippingPostalPrefix: string | null;
  presentmentCurrency: string;
  marketSignature: string;
  discountSignature: string;
  /** Cart total (sum of line discounted totals + shipping) in presentment currency. */
  cartTotal: number;
  /** Distinct total quantities observed across orders that share this signature. */
  quantitySamples: number[];
  observationCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  baseline: ExtractedBaseline;
}

export interface ExtractedBaseline {
  totalDiscountAmount: number;
  discountApplications: DiscountSnapshot[];
  shippingRateCode: string | null;
  shippingRateTitle: string | null;
  shippingRateAmount: number | null;
  paymentGatewayNames: string[];
  cartTotal: number;
  capturedAt: Date;
}

export interface ExtractStats {
  ordersConsidered: number;
  ordersDropped: number;
  fixturesEmitted: number;
}

/**
 * Build the canonical signature from a fixture's dedup-relevant fields. SHA-256
 * is overkill for this use case but cheap and avoids any risk of collisions
 * being treated as suspicious by future auditors. Inputs are normalised
 * upstream (lowercased tags, sorted, etc.) so the same composition always
 * hashes the same way.
 */
export function computeSignature(parts: {
  variantIds: string[];
  productFallbackIds: string[];
  customerTagSignature: string;
  shippingCountryCode: string | null;
  shippingPostalPrefix: string | null;
  presentmentCurrency: string;
  discountSignature: string;
}): string {
  // Sort variant ids deterministically. Variant identity dominates dedup —
  // two orders with the same products in different quantities collapse, but
  // two orders with different variants do not.
  const variants = [...parts.variantIds].sort();
  const products = [...parts.productFallbackIds].sort();
  const canonical = [
    "v=" + variants.join("|"),
    "p=" + products.join("|"),
    "tags=" + parts.customerTagSignature,
    "country=" + (parts.shippingCountryCode ?? ""),
    "postal=" + (parts.shippingPostalPrefix ?? ""),
    "currency=" + parts.presentmentCurrency,
    "discounts=" + parts.discountSignature,
  ].join(";");
  return createHash("sha256").update(canonical).digest("hex");
}

function parseMoney(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Discount codes and titles are merchant-controlled strings. We've seen
 * stores accidentally name codes after support contacts ("john@store.com" or
 * "+1-415-555-0142"). Redact PII-shaped values before they enter the
 * snapshot or the signature.
 */
const REDACTED = "[redacted]";
function redactIfPII(value: string | null | undefined): string | null {
  if (!value) return null;
  return containsLikelyPII(value) ? REDACTED : value;
}

function extractLineItems(raw: RawOrder): LineItemSnapshot[] {
  const items: LineItemSnapshot[] = [];
  const edges = raw.lineItems?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    items.push({
      variantId: node.variant?.id ?? null,
      productId: node.product?.id ?? null,
      sku: node.variant?.sku ?? node.sku ?? null,
      title: (node.title ?? "").slice(0, 200),
      quantity: typeof node.quantity === "number" ? node.quantity : 0,
      unitPrice: parseMoney(node.variant?.price),
    });
  }
  return items;
}

function extractDiscounts(raw: RawOrder): DiscountSnapshot[] {
  const out: DiscountSnapshot[] = [];
  const edges = raw.discountApplications?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    const value = node.value as
      | { __typename?: string; amount?: string; currencyCode?: string; percentage?: number }
      | null
      | undefined;
    out.push({
      type: node.__typename ?? "Unknown",
      // Discount code is merchant-controlled; scrub PII-shaped values
      // before storage AND before they reach the signature.
      code: redactIfPII(node.code ?? null),
      allocationMethod: node.allocationMethod ?? null,
      targetType: node.targetType ?? null,
      targetSelection: node.targetSelection ?? null,
      amount:
        value && value.__typename === "MoneyV2" && value.amount !== undefined
          ? parseMoney(value.amount)
          : null,
      percentage:
        value && value.__typename === "PricingPercentageValue" && typeof value.percentage === "number"
          ? value.percentage
          : null,
    });
  }
  return out;
}

function extractShipping(raw: RawOrder): {
  shippingRateCode: string | null;
  shippingRateTitle: string | null;
  shippingRateAmount: number | null;
} {
  // 2026-04 makes shippingLines a connection. Pick the first non-null line —
  // most orders have exactly one. Multi-leg shipments are out of scope here.
  const edges = raw.shippingLines?.edges ?? [];
  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;
    return {
      shippingRateCode: node.code ?? null,
      shippingRateTitle: node.title ?? null,
      shippingRateAmount: parseMoney(node.originalPriceSet?.presentmentMoney?.amount),
    };
  }
  return { shippingRateCode: null, shippingRateTitle: null, shippingRateAmount: null };
}

function discountSignatureFor(discounts: DiscountSnapshot[]): string {
  // Sort by code first, then type, so two orders with the same set of
  // discounts always produce the same signature regardless of API ordering.
  const tokens = discounts
    .map((d) => `${d.type}:${d.code ?? ""}:${d.targetType ?? ""}`)
    .sort();
  return tokens.join("|");
}

function marketSignatureFor(currency: string, country: string | null): string {
  return `${currency}/${country ?? "??"}`;
}

function totalQuantity(items: LineItemSnapshot[]): number {
  return items.reduce((sum, li) => sum + (li.quantity || 0), 0);
}

function cartTotalFor(raw: RawOrder): number {
  // Sum line-discounted totals + shipping originalPrice. We don't read
  // `currentTotalPrice` because not every order has one populated in the
  // current API response shape; this approach stays consistent across orders
  // and matches what we need for diff comparisons.
  let total = 0;
  for (const edge of raw.lineItems?.edges ?? []) {
    total += parseMoney(edge?.node?.discountedTotalSet?.presentmentMoney?.amount);
  }
  for (const edge of raw.shippingLines?.edges ?? []) {
    total += parseMoney(edge?.node?.originalPriceSet?.presentmentMoney?.amount);
  }
  return total;
}

function observedTotalDiscount(raw: RawOrder): number {
  // Source of truth: per-line `originalTotalSet - discountedTotalSet`. Works
  // for percentage discounts (where the DiscountApplication.value is a
  // PricingPercentageValue and the raw `amount` field is null), code
  // discounts, automatic discounts, and Script discounts uniformly. Summing
  // MoneyV2 values from `discountApplications` alone would under-report
  // percentage-driven savings.
  let total = 0;
  for (const edge of raw.lineItems?.edges ?? []) {
    const original = parseMoney(edge?.node?.originalTotalSet?.presentmentMoney?.amount);
    const discounted = parseMoney(edge?.node?.discountedTotalSet?.presentmentMoney?.amount);
    if (original > 0) total += Math.max(0, original - discounted);
  }
  return total;
}

/** Convert one Shopify Admin order into an unkeyed extracted-fixture record. */
export function extractFromOrder(raw: RawOrder): ExtractedFixture | null {
  if (!raw || typeof raw.id !== "string") return null;
  const lineItems = extractLineItems(raw);
  if (lineItems.length === 0) return null;

  const tags = scrubCustomerTags(raw.customer?.tags ?? []);
  const tagSig = tagSignature(tags);

  const address = scrubAddress({
    countryCode: raw.shippingAddress?.countryCode,
    zip: raw.shippingAddress?.zip,
  });

  const presentmentCurrency = (raw.presentmentCurrencyCode ?? raw.currencyCode ?? "USD").toUpperCase();
  const discounts = extractDiscounts(raw);
  const discountSig = discountSignatureFor(discounts);
  const market = marketSignatureFor(presentmentCurrency, address.countryCode);

  // Per-line identity: prefer variantId; fall back to productId on the same
  // line when the variant is null (Shopify retains the line with variant=null
  // after a hard-delete). Building the fallbacks per-line keeps mixed carts
  // distinct — e.g. a cart with one live variant + one deleted-variant line
  // does NOT collide with a cart that only has the live variant.
  const variantIds: string[] = [];
  const productFallbackIds: string[] = [];
  for (const li of lineItems) {
    if (li.variantId) {
      variantIds.push(li.variantId);
    } else if (li.productId) {
      productFallbackIds.push(li.productId);
    }
  }

  const signature = computeSignature({
    variantIds,
    productFallbackIds,
    customerTagSignature: tagSig,
    shippingCountryCode: address.countryCode,
    shippingPostalPrefix: address.postalPrefix,
    presentmentCurrency,
    discountSignature: discountSig,
  });

  const observed = pickTimestamp(raw);
  const cartTotal = cartTotalFor(raw);
  const shipping = extractShipping(raw);

  return {
    signature,
    lineItems,
    customerTags: tags,
    shippingCountryCode: address.countryCode,
    shippingPostalPrefix: address.postalPrefix,
    presentmentCurrency,
    marketSignature: market,
    discountSignature: discountSig,
    cartTotal,
    quantitySamples: [totalQuantity(lineItems)],
    observationCount: 1,
    firstObservedAt: observed,
    lastObservedAt: observed,
    baseline: {
      totalDiscountAmount: observedTotalDiscount(raw),
      discountApplications: discounts,
      shippingRateCode: shipping.shippingRateCode,
      shippingRateTitle: shipping.shippingRateTitle,
      shippingRateAmount: shipping.shippingRateAmount,
      paymentGatewayNames: (raw.paymentGatewayNames ?? []).filter(Boolean),
      cartTotal,
      capturedAt: observed,
    },
  };
}

function pickTimestamp(raw: RawOrder): Date {
  const ts = raw.processedAt ?? raw.createdAt;
  if (!ts) return new Date(0);
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d : new Date(0);
}

// Dedup / merge / batch logic lives in `./dedup.ts` so the extractor stays
// focused on per-order Shopify-Order shape. Both modules share the
// `ExtractedFixture` type defined above.
