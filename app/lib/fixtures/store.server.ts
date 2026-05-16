/**
 * Persistence layer for cart fixtures.
 *
 * Three responsibilities:
 *   1. Upsert ExtractedFixture rows by (shopDomain, signature) so re-runs are
 *      idempotent — clicking "Generate fixtures" twice in a row never produces
 *      duplicate rows.
 *   2. Re-merge against the existing row when one already exists, so we keep
 *      the cumulative observationCount + quantitySamples even across runs
 *      (previous run saw qty 1, today's run sees qty 5 → fixture has [1, 5]).
 *   3. Hydrate stored rows back into the in-memory shape the UI reads.
 *
 * Pure dispatch boundary: this is the only file in the fixtures stack that
 * imports Prisma. The route loader/action talks to this module; the extractor
 * and dedup modules stay pure.
 */
import db from "../../db.server";
import type { ExtractedFixture } from "./extractor";
import { mergeFixtures } from "./dedup";

export interface StoredFixture {
  id: string;
  shopDomain: string;
  signature: string;
  lineItems: unknown[];
  customerTagSignature: string;
  customerTags: string[];
  shippingCountryCode: string | null;
  shippingPostalPrefix: string | null;
  presentmentCurrency: string;
  marketSignature: string;
  discountSignature: string;
  quantitySamples: number[];
  observationCount: number;
  cartTotal: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  baseline: {
    totalDiscountAmount: number;
    discountApplications: unknown[];
    shippingRateCode: string | null;
    shippingRateTitle: string | null;
    shippingRateAmount: number | null;
    paymentGatewayNames: string[];
    cartTotal: number;
    capturedAt: Date;
  } | null;
}

/**
 * Persist a batch of extracted fixtures. Idempotent: each row is upserted by
 * (shopDomain, signature). When a row already exists we merge counts +
 * quantity samples + first/last observed range so historical breadth survives.
 *
 * Returns the count of rows touched (created or merged) for telemetry.
 */
export async function upsertFixtures(
  shopDomain: string,
  fixtures: ReadonlyArray<ExtractedFixture>,
): Promise<{ created: number; merged: number }> {
  let created = 0;
  let merged = 0;

  for (const incoming of fixtures) {
    // We don't use Prisma's `upsert` because we need to read the existing
    // row's accumulator fields to merge them with the incoming counts. A
    // raw upsert would clobber observationCount and quantitySamples on every
    // re-run.
    const existing = await db.cartFixture.findUnique({
      where: {
        shopDomain_signature: {
          shopDomain,
          signature: incoming.signature,
        },
      },
      include: { baseline: true },
    });

    if (!existing) {
      await db.cartFixture.create({
        data: serialiseInsert(shopDomain, incoming),
      });
      created++;
      continue;
    }

    // Hydrate existing → ExtractedFixture and re-run mergeFixtures so the
    // merge logic stays in one place (dedup.ts).
    const hydrated = hydrateForMerge(existing);
    const next = mergeFixtures(hydrated, incoming);

    await db.cartFixture.update({
      where: { id: existing.id },
      data: serialiseUpdate(next),
    });
    merged++;
  }

  return { created, merged };
}

/** List a shop's fixtures, newest first. UI-shaped result. */
export async function listFixtures(shopDomain: string): Promise<StoredFixture[]> {
  const rows = await db.cartFixture.findMany({
    where: { shopDomain },
    include: { baseline: true },
    orderBy: { lastObservedAt: "desc" },
  });
  return rows.map(hydrateStored);
}

/** Total fixture count for the shop, used in the dashboard summary. */
export async function countFixtures(shopDomain: string): Promise<number> {
  return db.cartFixture.count({ where: { shopDomain } });
}

/** Wipe all fixtures for a shop. Available from the UI for re-runs that want a clean start. */
export async function deleteAllFixtures(shopDomain: string): Promise<number> {
  const result = await db.cartFixture.deleteMany({ where: { shopDomain } });
  return result.count;
}

function safeParseJson<T>(value: string, fallback: T): T {
  try {
    const parsed = JSON.parse(value);
    return parsed as T;
  } catch {
    return fallback;
  }
}

function serialiseInsert(shopDomain: string, f: ExtractedFixture) {
  return {
    shopDomain,
    signature: f.signature,
    lineItems: JSON.stringify(f.lineItems),
    customerTagSignature: f.customerTags.join(","),
    shippingCountryCode: f.shippingCountryCode,
    shippingPostalPrefix: f.shippingPostalPrefix,
    presentmentCurrency: f.presentmentCurrency,
    marketSignature: f.marketSignature,
    discountSignature: f.discountSignature,
    quantitySamples: JSON.stringify(f.quantitySamples),
    observationCount: f.observationCount,
    firstObservedAt: f.firstObservedAt,
    lastObservedAt: f.lastObservedAt,
    baseline: {
      create: {
        totalDiscountAmount: f.baseline.totalDiscountAmount,
        discountApplications: JSON.stringify(f.baseline.discountApplications),
        shippingRateCode: f.baseline.shippingRateCode,
        shippingRateTitle: f.baseline.shippingRateTitle,
        shippingRateAmount: f.baseline.shippingRateAmount,
        paymentGatewayNames: JSON.stringify(f.baseline.paymentGatewayNames),
        cartTotal: f.baseline.cartTotal,
        capturedAt: f.baseline.capturedAt,
      },
    },
  };
}

function serialiseUpdate(f: ExtractedFixture) {
  return {
    lineItems: JSON.stringify(f.lineItems),
    customerTagSignature: f.customerTags.join(","),
    shippingCountryCode: f.shippingCountryCode,
    shippingPostalPrefix: f.shippingPostalPrefix,
    presentmentCurrency: f.presentmentCurrency,
    marketSignature: f.marketSignature,
    discountSignature: f.discountSignature,
    quantitySamples: JSON.stringify(f.quantitySamples),
    observationCount: f.observationCount,
    firstObservedAt: f.firstObservedAt,
    lastObservedAt: f.lastObservedAt,
    baseline: {
      upsert: {
        create: {
          totalDiscountAmount: f.baseline.totalDiscountAmount,
          discountApplications: JSON.stringify(f.baseline.discountApplications),
          shippingRateCode: f.baseline.shippingRateCode,
          shippingRateTitle: f.baseline.shippingRateTitle,
          shippingRateAmount: f.baseline.shippingRateAmount,
          paymentGatewayNames: JSON.stringify(f.baseline.paymentGatewayNames),
          cartTotal: f.baseline.cartTotal,
          capturedAt: f.baseline.capturedAt,
        },
        update: {
          totalDiscountAmount: f.baseline.totalDiscountAmount,
          discountApplications: JSON.stringify(f.baseline.discountApplications),
          shippingRateCode: f.baseline.shippingRateCode,
          shippingRateTitle: f.baseline.shippingRateTitle,
          shippingRateAmount: f.baseline.shippingRateAmount,
          paymentGatewayNames: JSON.stringify(f.baseline.paymentGatewayNames),
          cartTotal: f.baseline.cartTotal,
          capturedAt: f.baseline.capturedAt,
        },
      },
    },
  };
}

interface DbFixture {
  id: string;
  shopDomain: string;
  signature: string;
  lineItems: string;
  customerTagSignature: string;
  shippingCountryCode: string | null;
  shippingPostalPrefix: string | null;
  presentmentCurrency: string;
  marketSignature: string;
  discountSignature: string;
  quantitySamples: string;
  observationCount: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
  baseline: {
    totalDiscountAmount: number;
    discountApplications: string;
    shippingRateCode: string | null;
    shippingRateTitle: string | null;
    shippingRateAmount: number | null;
    paymentGatewayNames: string;
    cartTotal: number;
    capturedAt: Date;
  } | null;
}

function hydrateStored(row: DbFixture): StoredFixture {
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    signature: row.signature,
    lineItems: safeParseJson(row.lineItems, []),
    customerTagSignature: row.customerTagSignature,
    customerTags: row.customerTagSignature
      ? row.customerTagSignature.split(",").filter(Boolean)
      : [],
    shippingCountryCode: row.shippingCountryCode,
    shippingPostalPrefix: row.shippingPostalPrefix,
    presentmentCurrency: row.presentmentCurrency,
    marketSignature: row.marketSignature,
    discountSignature: row.discountSignature,
    quantitySamples: safeParseJson<number[]>(row.quantitySamples, []),
    observationCount: row.observationCount,
    cartTotal: row.baseline?.cartTotal ?? 0,
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    baseline: row.baseline
      ? {
          totalDiscountAmount: row.baseline.totalDiscountAmount,
          discountApplications: safeParseJson<unknown[]>(
            row.baseline.discountApplications,
            [],
          ),
          shippingRateCode: row.baseline.shippingRateCode,
          shippingRateTitle: row.baseline.shippingRateTitle,
          shippingRateAmount: row.baseline.shippingRateAmount,
          paymentGatewayNames: safeParseJson<string[]>(
            row.baseline.paymentGatewayNames,
            [],
          ),
          cartTotal: row.baseline.cartTotal,
          capturedAt: row.baseline.capturedAt,
        }
      : null,
  };
}

function hydrateForMerge(row: DbFixture): ExtractedFixture {
  // Reconstruct an ExtractedFixture so dedup.mergeFixtures can run unchanged.
  return {
    signature: row.signature,
    lineItems: safeParseJson(row.lineItems, []) as ExtractedFixture["lineItems"],
    customerTags: row.customerTagSignature
      ? row.customerTagSignature.split(",").filter(Boolean)
      : [],
    shippingCountryCode: row.shippingCountryCode,
    shippingPostalPrefix: row.shippingPostalPrefix,
    presentmentCurrency: row.presentmentCurrency,
    marketSignature: row.marketSignature,
    discountSignature: row.discountSignature,
    cartTotal: row.baseline?.cartTotal ?? 0,
    quantitySamples: safeParseJson<number[]>(row.quantitySamples, []),
    observationCount: row.observationCount,
    firstObservedAt: row.firstObservedAt,
    lastObservedAt: row.lastObservedAt,
    baseline: {
      totalDiscountAmount: row.baseline?.totalDiscountAmount ?? 0,
      discountApplications: (safeParseJson<unknown[]>(
        row.baseline?.discountApplications ?? "[]",
        [],
      ) as ExtractedFixture["baseline"]["discountApplications"]),
      shippingRateCode: row.baseline?.shippingRateCode ?? null,
      shippingRateTitle: row.baseline?.shippingRateTitle ?? null,
      shippingRateAmount: row.baseline?.shippingRateAmount ?? null,
      paymentGatewayNames: safeParseJson<string[]>(
        row.baseline?.paymentGatewayNames ?? "[]",
        [],
      ),
      cartTotal: row.baseline?.cartTotal ?? 0,
      capturedAt: row.baseline?.capturedAt ?? row.lastObservedAt,
    },
  };
}
