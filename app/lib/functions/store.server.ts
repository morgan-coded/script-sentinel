/**
 * Persistence boundary for DiscoveredFunction, CaptureRun, and
 * FunctionOutput.
 *
 * Reuses the fixture extractor + dedup signature so FunctionOutput rows
 * align with CartFixture rows by `fixtureSignature`. The diff engine reads
 * both and compares apples-to-apples.
 */
import db from "../../db.server";
import {
  categorizeApiType,
  type FunctionCategory,
  type RawShopifyFunction,
} from "../shopify/functions";
import { extractFromOrder } from "../fixtures/extractor";
import type { RawOrder } from "../shopify/orders";

export interface DiscoveredFunctionRecord {
  id: string;
  shopDomain: string;
  externalId: string;
  title: string;
  apiType: string;
  apiVersion: string | null;
  appTitle: string | null;
  category: FunctionCategory;
  acknowledgedAt: Date | null;
  lastSeenAt: Date;
  uninstalledAt: Date | null;
}

export interface CaptureRunSummary {
  id: string;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: Date;
  finishedAt: Date | null;
  windowFromAt: Date;
  windowToAt: Date;
  ordersExamined: number;
  outputsCaptured: number;
  errorMessage: string | null;
}

export interface FunctionOutputRecord {
  id: string;
  shopDomain: string;
  captureRunId: string;
  functionId: string | null;
  sourceOrderGid: string;
  fixtureSignature: string;
  observedDiscountAmount: number;
  observedShippingCode: string | null;
  observedShippingTitle: string | null;
  observedShippingAmount: number | null;
  observedPaymentGateways: string[];
  observedDiscountCodes: string[];
  cartTotal: number;
  presentmentCurrency: string;
  capturedAt: Date;
}

/**
 * Upsert the discovered Functions for a shop. Marks a Function as
 * uninstalled (sets uninstalledAt) when it disappears from the discovery
 * list — Shopify removed the row but we keep the historical record so
 * captures attributed to it stay readable.
 */
export async function upsertDiscoveredFunctions(
  shopDomain: string,
  raw: ReadonlyArray<RawShopifyFunction>,
): Promise<{ created: number; updated: number; uninstalled: number }> {
  const now = new Date();
  const existing = await db.discoveredFunction.findMany({
    where: { shopDomain },
    select: { id: true, externalId: true, uninstalledAt: true },
  });
  const existingByExternalId = new Map(existing.map((e) => [e.externalId, e]));
  const seenExternalIds = new Set<string>();

  let created = 0;
  let updated = 0;

  for (const fn of raw) {
    seenExternalIds.add(fn.id);
    const prior = existingByExternalId.get(fn.id);
    if (prior) {
      await db.discoveredFunction.update({
        where: { id: prior.id },
        data: {
          title: fn.title,
          apiType: fn.apiType,
          apiVersion: fn.apiVersion ?? null,
          appTitle: fn.app?.title ?? null,
          lastSeenAt: now,
          uninstalledAt: null,
        },
      });
      updated++;
    } else {
      await db.discoveredFunction.create({
        data: {
          shopDomain,
          externalId: fn.id,
          title: fn.title,
          apiType: fn.apiType,
          apiVersion: fn.apiVersion ?? null,
          appTitle: fn.app?.title ?? null,
          lastSeenAt: now,
        },
      });
      created++;
    }
  }

  // Mark previously-seen Functions that were not in this discovery as
  // uninstalled. Don't overwrite an existing uninstalledAt (keep the
  // earliest known disappearance).
  let uninstalled = 0;
  for (const e of existing) {
    if (!seenExternalIds.has(e.externalId) && !e.uninstalledAt) {
      await db.discoveredFunction.update({
        where: { id: e.id },
        data: { uninstalledAt: now },
      });
      uninstalled++;
    }
  }

  return { created, updated, uninstalled };
}

export async function listDiscoveredFunctions(
  shopDomain: string,
): Promise<DiscoveredFunctionRecord[]> {
  const rows = await db.discoveredFunction.findMany({
    where: { shopDomain },
    orderBy: [{ uninstalledAt: "asc" }, { title: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    shopDomain: row.shopDomain,
    externalId: row.externalId,
    title: row.title,
    apiType: row.apiType,
    apiVersion: row.apiVersion,
    appTitle: row.appTitle,
    category: categorizeApiType(row.apiType),
    acknowledgedAt: row.acknowledgedAt,
    lastSeenAt: row.lastSeenAt,
    uninstalledAt: row.uninstalledAt,
  }));
}

/**
 * Pick the best DiscoveredFunction id to attribute a per-order observation
 * to, given the captured outcome shape. Heuristic — the only viable
 * heuristic without a Shopify-side attribution API:
 *   - If the outcome includes a discount delta → look for an active discount
 *     Function.
 *   - Else if shipping rate captured → look for a shipping Function.
 *   - Else if payment gateways captured → look for a payment Function.
 *   - Else → null (uncategorized output, still stored for trend analysis).
 *
 * Returns a Map of category → DiscoveredFunction.id for fast lookup. Pass
 * the same Map across every order in a CaptureRun.
 */
export function buildCategoryAttributionMap(
  functions: ReadonlyArray<DiscoveredFunctionRecord>,
): Map<FunctionCategory, string> {
  const out = new Map<FunctionCategory, string>();
  for (const fn of functions) {
    if (fn.uninstalledAt) continue;
    if (!out.has(fn.category)) out.set(fn.category, fn.id);
  }
  return out;
}

export interface CaptureWindow {
  from: Date;
  to: Date;
}

export async function startCaptureRun(
  shopDomain: string,
  window: CaptureWindow,
): Promise<{ id: string }> {
  const run = await db.captureRun.create({
    data: {
      shopDomain,
      windowFromAt: window.from,
      windowToAt: window.to,
      status: "running",
    },
    select: { id: true },
  });
  return run;
}

export async function finishCaptureRun(
  id: string,
  result: {
    status: "completed" | "failed";
    ordersExamined: number;
    outputsCaptured: number;
    errorMessage?: string;
  },
): Promise<void> {
  await db.captureRun.update({
    where: { id },
    data: {
      status: result.status,
      finishedAt: new Date(),
      ordersExamined: result.ordersExamined,
      outputsCaptured: result.outputsCaptured,
      errorMessage: result.errorMessage ?? null,
    },
  });
}

/**
 * Persist a batch of FunctionOutput rows from raw orders. Idempotent: keyed
 * on (shopDomain, fixtureSignature, sourceOrderGid). Re-runs do NOT
 * duplicate rows for the same source order.
 *
 * Returns the count of NEW outputs persisted (re-runs report 0).
 */
export async function persistFunctionOutputsFromOrders(
  shopDomain: string,
  captureRunId: string,
  orders: ReadonlyArray<RawOrder>,
  attribution: Map<FunctionCategory, string>,
): Promise<{ outputsCaptured: number; ordersConsidered: number }> {
  let outputsCaptured = 0;
  for (const order of orders) {
    const extracted = extractFromOrder(order);
    if (!extracted || !extracted.baseline) continue;
    const sourceOrderGid = order.id;
    if (!sourceOrderGid) continue;

    // Attribute by the dominant outcome shape:
    //   - discount delta present → discount Function
    //   - else shipping captured → shipping Function
    //   - else payment captured → payment Function
    //   - else null
    let attributedFunctionId: string | null = null;
    if (extracted.baseline.totalDiscountAmount > 0) {
      attributedFunctionId = attribution.get("discount") ?? null;
    } else if (extracted.baseline.shippingRateAmount !== null) {
      attributedFunctionId = attribution.get("shipping") ?? null;
    } else if (extracted.baseline.paymentGatewayNames.length > 0) {
      attributedFunctionId = attribution.get("payment") ?? null;
    }

    const observedDiscountCodes = extracted.baseline.discountApplications
      .map((d) => d.code)
      .filter((c): c is string => Boolean(c));

    try {
      await db.functionOutput.create({
        data: {
          shopDomain,
          captureRunId,
          functionId: attributedFunctionId,
          sourceOrderGid,
          fixtureSignature: extracted.signature,
          observedDiscountAmount: extracted.baseline.totalDiscountAmount,
          observedShippingCode: extracted.baseline.shippingRateCode,
          observedShippingTitle: extracted.baseline.shippingRateTitle,
          observedShippingAmount: extracted.baseline.shippingRateAmount,
          observedPaymentGateways: JSON.stringify(extracted.baseline.paymentGatewayNames),
          observedDiscountCodes: JSON.stringify(observedDiscountCodes),
          cartTotal: extracted.cartTotal,
          presentmentCurrency: extracted.presentmentCurrency,
          capturedAt: extracted.lastObservedAt,
        },
      });
      outputsCaptured++;
    } catch (err) {
      // Unique-constraint conflict on re-runs for the same source order is
      // expected; treat as no-op so the runner is idempotent. Anything else
      // bubbles up.
      const message = err instanceof Error ? err.message : String(err);
      if (!/unique/i.test(message)) throw err;
    }
  }
  return { outputsCaptured, ordersConsidered: orders.length };
}

export async function listFunctionOutputs(
  shopDomain: string,
  options: { functionId?: string; limit?: number } = {},
): Promise<FunctionOutputRecord[]> {
  const rows = await db.functionOutput.findMany({
    where: {
      shopDomain,
      ...(options.functionId ? { functionId: options.functionId } : {}),
    },
    orderBy: { capturedAt: "desc" },
    take: options.limit ?? 200,
  });
  return rows.map((row) => ({
    id: row.id,
    shopDomain: row.shopDomain,
    captureRunId: row.captureRunId,
    functionId: row.functionId,
    sourceOrderGid: row.sourceOrderGid,
    fixtureSignature: row.fixtureSignature,
    observedDiscountAmount: row.observedDiscountAmount,
    observedShippingCode: row.observedShippingCode,
    observedShippingTitle: row.observedShippingTitle,
    observedShippingAmount: row.observedShippingAmount,
    observedPaymentGateways: safeJsonArray(row.observedPaymentGateways),
    observedDiscountCodes: safeJsonArray(row.observedDiscountCodes),
    cartTotal: row.cartTotal,
    presentmentCurrency: row.presentmentCurrency,
    capturedAt: row.capturedAt,
  }));
}

export async function listCaptureRuns(shopDomain: string): Promise<CaptureRunSummary[]> {
  const rows = await db.captureRun.findMany({
    where: { shopDomain },
    orderBy: { startedAt: "desc" },
    take: 25,
  });
  return rows.map((row) => ({
    id: row.id,
    status: (row.status as CaptureRunSummary["status"]) ?? "pending",
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    windowFromAt: row.windowFromAt,
    windowToAt: row.windowToAt,
    ordersExamined: row.ordersExamined,
    outputsCaptured: row.outputsCaptured,
    errorMessage: row.errorMessage,
  }));
}

export async function countFunctionOutputs(
  shopDomain: string,
  functionId: string,
): Promise<number> {
  return db.functionOutput.count({
    where: { shopDomain, functionId },
  });
}

export async function countAllFunctionOutputs(shopDomain: string): Promise<number> {
  return db.functionOutput.count({ where: { shopDomain } });
}

function safeJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
