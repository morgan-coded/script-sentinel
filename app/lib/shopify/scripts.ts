/**
 * Script Sentinel — script discovery and persistence.
 *
 * Slice 2 verification 2026-04-29 confirmed (across the 2026-04 GraphQL
 * schema, REST docs, and Shopify's own deprecation guidance) that **there is
 * no Admin API endpoint for legacy Shopify Scripts**. Shopify's only
 * migration-time discovery surface is the Customizations report inside the
 * admin UI. So this module ships merchant-paste as the primary intake.
 *
 * The interface still distinguishes intake `origin` so a future Admin API
 * path is a one-function addition rather than a model rewrite.
 *
 * No write scopes; this module never mutates Shopify state.
 */

import db from "../../db.server";
import {
  asCategory,
  classifyScript,
  type ClassificationCategory,
} from "../classifier/script-classifier";

export const SCRIPT_TYPES = ["line_item", "shipping", "payment", "unknown"] as const;
export type ScriptType = (typeof SCRIPT_TYPES)[number];

export const SCRIPT_ORIGINS = ["paste", "admin_api"] as const;
export type ScriptOrigin = (typeof SCRIPT_ORIGINS)[number];

export interface DiscoveredScriptRecord {
  id: string;
  shopDomain: string;
  title: string;
  scriptType: ScriptType;
  source: string;
  isActive: boolean;
  archivedAt: Date | null;
  origin: ScriptOrigin;
  externalId: string | null;
  shopifyUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  classification: {
    autoCategory: ClassificationCategory;
    autoConfidence: number;
    autoSignals: string[];
    overrideCategory: ClassificationCategory | null;
    overrideReason: string | null;
    overrideUpdatedAt: Date | null;
  };
}

/**
 * Coerce a free-form input to a ScriptType. The merchant-paste form uses a
 * <select> bound to these values, but defensive coercion keeps the type safe
 * if the form is bypassed.
 */
export function asScriptType(raw: string | null | undefined): ScriptType {
  if (!raw) return "unknown";
  return (SCRIPT_TYPES as readonly string[]).includes(raw)
    ? (raw as ScriptType)
    : "unknown";
}

interface PasteInput {
  shopDomain: string;
  title: string;
  source: string;
  scriptType: ScriptType;
  isActive?: boolean;
}

/**
 * Persist a merchant-pasted script and run the heuristic classifier in a
 * single transaction so the DiscoveredScript and its ScriptClassification
 * always exist together (the dashboard assumes a 1:1 invariant).
 */
export async function createPastedScript(input: PasteInput): Promise<string> {
  const classification = classifyScript(input.source);
  const script = await db.discoveredScript.create({
    data: {
      shopDomain: input.shopDomain,
      title: input.title.trim() || "(untitled script)",
      // Store source verbatim. Untrusted text — never rendered as HTML.
      source: input.source,
      scriptType: input.scriptType,
      origin: "paste",
      isActive: input.isActive ?? true,
      classification: {
        create: {
          autoCategory: classification.category,
          autoConfidence: classification.confidence,
          autoSignals: JSON.stringify(classification.signals),
        },
      },
    },
  });
  return script.id;
}

/** Re-run the classifier (e.g. after a heuristic change) without losing overrides. */
export async function reclassifyAuto(scriptId: string): Promise<void> {
  const script = await db.discoveredScript.findUnique({
    where: { id: scriptId },
    select: { source: true },
  });
  if (!script) return;
  const result = classifyScript(script.source);
  await db.scriptClassification.update({
    where: { scriptId },
    data: {
      autoCategory: result.category,
      autoConfidence: result.confidence,
      autoSignals: JSON.stringify(result.signals),
    },
  });
}

/**
 * Apply a merchant-supplied category override. Pass null to clear.
 *
 * The override survives subsequent auto-classification runs; this is the
 * "manual reclassification" requirement called out in the slice acceptance
 * criteria. The reason field is optional but useful for audit.
 */
export async function setOverrideCategory(
  scriptId: string,
  override: ClassificationCategory | null,
  reason: string | null,
): Promise<void> {
  await db.scriptClassification.update({
    where: { scriptId },
    data: {
      overrideCategory: override,
      overrideReason: override ? reason : null,
      overrideUpdatedAt: override ? new Date() : null,
    },
  });
}

/** Soft-archive a script. Keeps the row for re-activation later. */
export async function archiveScript(scriptId: string): Promise<void> {
  await db.discoveredScript.update({
    where: { id: scriptId },
    data: { isActive: false, archivedAt: new Date() },
  });
}

export async function unarchiveScript(scriptId: string): Promise<void> {
  await db.discoveredScript.update({
    where: { id: scriptId },
    data: { isActive: true, archivedAt: null },
  });
}

export async function deleteScript(scriptId: string): Promise<void> {
  // ScriptClassification cascades via the onDelete: Cascade relation.
  await db.discoveredScript.delete({ where: { id: scriptId } });
}

function hydrate(row: {
  id: string;
  shopDomain: string;
  title: string;
  source: string;
  scriptType: string;
  isActive: boolean;
  archivedAt: Date | null;
  origin: string;
  externalId: string | null;
  shopifyUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  classification: {
    autoCategory: string;
    autoConfidence: number;
    autoSignals: string;
    overrideCategory: string | null;
    overrideReason: string | null;
    overrideUpdatedAt: Date | null;
  } | null;
}): DiscoveredScriptRecord {
  // Defensive: classification should always exist (we create it transactionally
  // with the script), but if someone manually inserts a row we fall back to a
  // synthetic "needs review" record so the UI doesn't crash.
  const classification = row.classification;
  let signals: string[] = [];
  if (classification?.autoSignals) {
    try {
      const parsed = JSON.parse(classification.autoSignals);
      if (Array.isArray(parsed)) signals = parsed.map(String);
    } catch {
      signals = [];
    }
  }
  return {
    id: row.id,
    shopDomain: row.shopDomain,
    title: row.title,
    scriptType: asScriptType(row.scriptType),
    source: row.source,
    isActive: row.isActive,
    archivedAt: row.archivedAt,
    origin: (SCRIPT_ORIGINS as readonly string[]).includes(row.origin)
      ? (row.origin as ScriptOrigin)
      : "paste",
    externalId: row.externalId,
    shopifyUpdatedAt: row.shopifyUpdatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    classification: {
      autoCategory:
        asCategory(classification?.autoCategory) ?? ("other" as ClassificationCategory),
      autoConfidence: classification?.autoConfidence ?? 0,
      autoSignals: signals,
      overrideCategory: asCategory(classification?.overrideCategory ?? null),
      overrideReason: classification?.overrideReason ?? null,
      overrideUpdatedAt: classification?.overrideUpdatedAt ?? null,
    },
  };
}

export async function listScripts(shopDomain: string): Promise<DiscoveredScriptRecord[]> {
  const rows = await db.discoveredScript.findMany({
    where: { shopDomain },
    include: { classification: true },
    orderBy: [{ isActive: "desc" }, { updatedAt: "desc" }],
  });
  return rows.map(hydrate);
}

export async function getScript(
  shopDomain: string,
  id: string,
): Promise<DiscoveredScriptRecord | null> {
  const row = await db.discoveredScript.findFirst({
    where: { id, shopDomain },
    include: { classification: true },
  });
  return row ? hydrate(row) : null;
}
