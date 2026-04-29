/**
 * Audit persistence layer — Prisma boundary for AuditPurchase and AuditReport.
 *
 * Slice 4 keeps the structured snapshot as the source of truth and re-renders
 * the PDF on every download (see prisma/schema.prisma rationale). This module
 * is the only place the audit code talks to Prisma.
 */
import db from "../../db.server";
import { BILLING_PRODUCTS } from "../billing/products";
import {
  type AuditPlanKey,
  scopeForPlan,
} from "../billing/charge.server";
import type { AuditSnapshot } from "./risk-scorer";

const TWELVE_MONTHS_MS = 1000 * 60 * 60 * 24 * 365;

export interface SavedReport {
  id: string;
  shopDomain: string;
  scope: "single" | "multi";
  scriptCount: number;
  fixtureCount: number;
  highRiskCount: number;
  generatedAt: Date;
  filename: string;
  snapshot: AuditSnapshot;
}

/**
 * Mark an audit purchase as ACTIVE after Shopify confirms the charge. Sets
 * the 12-month re-download window. Idempotent on `shopifyChargeGid`: if the
 * charge has already been recorded, we simply update status/activatedAt.
 */
export async function recordActivePurchase(
  shopDomain: string,
  options: {
    plan: AuditPlanKey;
    shopifyChargeGid: string;
    isTest: boolean;
  },
): Promise<{ id: string }> {
  const product = BILLING_PRODUCTS[options.plan];
  const now = new Date();
  const existing = await db.auditPurchase.findUnique({
    where: { shopifyChargeGid: options.shopifyChargeGid },
  });
  if (existing) {
    if (existing.status === "active") return { id: existing.id };
    const updated = await db.auditPurchase.update({
      where: { id: existing.id },
      data: {
        status: "active",
        activatedAt: now,
        expiresAt: new Date(now.getTime() + TWELVE_MONTHS_MS),
      },
    });
    return { id: updated.id };
  }
  const created = await db.auditPurchase.create({
    data: {
      shopDomain,
      planKey: options.plan,
      amount: product.amount,
      currencyCode: product.currencyCode,
      shopifyChargeGid: options.shopifyChargeGid,
      isTest: options.isTest,
      status: "active",
      activatedAt: now,
      expiresAt: new Date(now.getTime() + TWELVE_MONTHS_MS),
    },
  });
  return { id: created.id };
}

/** Most recent active audit purchase for the shop, or null. */
export async function getActivePurchase(shopDomain: string) {
  return db.auditPurchase.findFirst({
    where: { shopDomain, status: "active" },
    orderBy: { activatedAt: "desc" },
  });
}

export async function saveAuditReport(options: {
  shopDomain: string;
  purchaseId: string;
  snapshot: AuditSnapshot;
}): Promise<SavedReport> {
  const filename = `script-sentinel-audit-${options.shopDomain}-${options.snapshot.generatedAt.slice(0, 10)}.pdf`;
  const row = await db.auditReport.create({
    data: {
      shopDomain: options.shopDomain,
      purchaseId: options.purchaseId,
      scope: scopeForPlan(getPurchasePlan(options.snapshot)),
      snapshot: JSON.stringify(options.snapshot),
      scriptCount: options.snapshot.counts.scripts,
      fixtureCount: options.snapshot.counts.fixtures,
      highRiskCount: options.snapshot.counts.highRisk,
      filename,
    },
  });
  return hydrate(row);
}

function getPurchasePlan(snapshot: AuditSnapshot): AuditPlanKey {
  return snapshot.scope === "multi" ? "MULTI_SCRIPT_AUDIT" : "MIGRATION_RISK_AUDIT";
}

export async function listReports(shopDomain: string): Promise<SavedReport[]> {
  const rows = await db.auditReport.findMany({
    where: { shopDomain },
    orderBy: { generatedAt: "desc" },
  });
  return rows.map(hydrate);
}

export async function getReport(
  shopDomain: string,
  id: string,
): Promise<SavedReport | null> {
  const row = await db.auditReport.findFirst({
    where: { id, shopDomain },
  });
  return row ? hydrate(row) : null;
}

interface DbReport {
  id: string;
  shopDomain: string;
  scope: string;
  snapshot: string;
  scriptCount: number;
  fixtureCount: number;
  highRiskCount: number;
  generatedAt: Date;
  filename: string;
}

function hydrate(row: DbReport): SavedReport {
  let snapshot: AuditSnapshot;
  try {
    snapshot = JSON.parse(row.snapshot) as AuditSnapshot;
  } catch {
    // Corrupt rows shouldn't crash the route; render an empty placeholder
    // snapshot so the merchant gets feedback rather than a 500.
    snapshot = {
      schemaVersion: 1,
      shopName: "(snapshot unavailable)",
      shopDomain: row.shopDomain,
      planDisplayName: null,
      scope: row.scope === "multi" ? "multi" : "single",
      generatedAt: row.generatedAt.toISOString(),
      counts: {
        scripts: 0,
        activeScripts: 0,
        fixtures: 0,
        highRisk: 0,
        mediumRisk: 0,
        lowRisk: 0,
        unknownRisk: 0,
      },
      topRisks: [],
      scripts: [],
      fixtures: [],
      checklist: [],
      openQuestions: [],
    };
  }
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    scope: row.scope === "multi" ? "multi" : "single",
    scriptCount: row.scriptCount,
    fixtureCount: row.fixtureCount,
    highRiskCount: row.highRiskCount,
    generatedAt: row.generatedAt,
    filename: row.filename,
    snapshot,
  };
}
