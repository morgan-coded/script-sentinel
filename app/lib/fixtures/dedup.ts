/**
 * Fixture deduplication.
 *
 * Two orders that collapse into the same fixture share:
 *   - the same set of variant ids (composition)
 *   - the same scrubbed customer-tag signature
 *   - the same shipping country code
 *   - the same presentment currency
 *   - the same applied-discount signature (codes + types)
 *
 * Quantity differences do NOT split fixtures: we collect distinct total-cart
 * quantities into `quantitySamples` so the audit can see "this composition
 * was bought as quantity 1, 2, and 5 times across 12 orders". This is the
 * roadmap rule:
 *
 *   "Two orders with same products + same customer tags + same shipping
 *    country + same applied discount = one fixture. Quantity variations
 *    matter; preserve quantity diversity."
 *
 * The merge keeps the *freshest* baseline (most recent order is the truest
 * ground truth) while accumulating the historical breadth.
 */

import type { ExtractedFixture, ExtractStats } from "./extractor";
import { extractFromOrder } from "./extractor";
import type { RawOrder } from "../shopify/orders";

/**
 * Combine two same-signature fixtures into one. Order doesn't matter:
 * mergeFixtures(a, b) === mergeFixtures(b, a) for the merged-state values
 * (counts, quantitySamples, first/last observed). Throws on signature mismatch
 * — that's a programmer error, not a data error.
 */
export function mergeFixtures(
  existing: ExtractedFixture,
  next: ExtractedFixture,
): ExtractedFixture {
  if (existing.signature !== next.signature) {
    throw new Error("mergeFixtures called with different signatures");
  }
  const newer = next.lastObservedAt >= existing.lastObservedAt ? next : existing;
  const older = newer === existing ? next : existing;
  const quantities = new Set<number>([
    ...existing.quantitySamples,
    ...next.quantitySamples,
  ]);
  return {
    ...newer,
    quantitySamples: [...quantities].sort((a, b) => a - b),
    observationCount: existing.observationCount + next.observationCount,
    firstObservedAt:
      existing.firstObservedAt < next.firstObservedAt
        ? existing.firstObservedAt
        : next.firstObservedAt,
    lastObservedAt:
      existing.lastObservedAt > next.lastObservedAt
        ? existing.lastObservedAt
        : next.lastObservedAt,
    // Baseline tracks the freshest order so the diff engine compares against
    // the most recent ground truth.
    baseline: newer.baseline,
    // Cart total: keep the freshest. A future revision may want a histogram
    // instead but single-value is enough here.
    cartTotal: newer.cartTotal,
    // Carry forward the older record's invariant fields if they happen to be
    // null on the newer one (e.g. shipping country was missing on a later
    // order). This is defensive, not load-bearing.
    shippingCountryCode: newer.shippingCountryCode ?? older.shippingCountryCode,
    shippingPostalPrefix: newer.shippingPostalPrefix ?? older.shippingPostalPrefix,
  };
}

/**
 * Take a list of raw Shopify orders and produce the deduplicated fixture set
 * plus stats. Single pass:
 *   - extract per order (drops orders that fail extraction, e.g. zero line items)
 *   - bucket by signature in a Map
 *   - merge into the bucket on collision
 */
export function extractFixtures(orders: ReadonlyArray<RawOrder>): {
  fixtures: ExtractedFixture[];
  stats: ExtractStats;
} {
  const buckets = new Map<string, ExtractedFixture>();
  let dropped = 0;
  for (const order of orders) {
    const extracted = extractFromOrder(order);
    if (!extracted) {
      dropped++;
      continue;
    }
    const existing = buckets.get(extracted.signature);
    if (existing) {
      buckets.set(extracted.signature, mergeFixtures(existing, extracted));
    } else {
      buckets.set(extracted.signature, extracted);
    }
  }
  const fixtures = [...buckets.values()].sort(
    (a, b) => b.lastObservedAt.getTime() - a.lastObservedAt.getTime(),
  );
  return {
    fixtures,
    stats: {
      ordersConsidered: orders.length,
      ordersDropped: dropped,
      fixturesEmitted: fixtures.length,
    },
  };
}
