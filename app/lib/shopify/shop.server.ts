/**
 * Shop persistence helpers. Wraps Prisma Shop + Charge so route loaders don't
 * sprinkle DB calls everywhere. Slice 1 uses these from:
 *   - app/routes/app._index.tsx (dashboard loader)
 *   - app/routes/webhooks.app.uninstalled.tsx (cleanup)
 */
import db from "../../db.server";
import type { ShopPlanSnapshot } from "./plan.server";

export interface ShopRecord {
  myshopifyDomain: string;
  shopName: string | null;
  isPlus: boolean;
  isDevelopment: boolean;
  planDisplayName: string | null;
  installedAt: Date;
  lastSeenAt: Date;
  uninstalledAt: Date | null;
}

/**
 * Upsert a Shop row from a fresh plan snapshot. Idempotent — safe to call from
 * every authenticated request that already has the plan loaded. Cheap because
 * the row is keyed by myshopifyDomain.
 */
export async function upsertShopFromPlan(
  myshopifyDomain: string,
  snapshot: ShopPlanSnapshot & { shopName: string | null },
): Promise<ShopRecord> {
  return db.shop.upsert({
    where: { myshopifyDomain },
    update: {
      shopName: snapshot.shopName,
      isPlus: snapshot.isPlus,
      isDevelopment: snapshot.isDevelopment,
      planDisplayName: snapshot.publicDisplayName,
      lastSeenAt: new Date(),
      uninstalledAt: null,
    },
    create: {
      myshopifyDomain,
      shopName: snapshot.shopName,
      isPlus: snapshot.isPlus,
      isDevelopment: snapshot.isDevelopment,
      planDisplayName: snapshot.publicDisplayName,
    },
  });
}

/**
 * Mark every record for this shop as uninstalled and drop sessions. Called from
 * the app/uninstalled webhook. Cascade on Shop -> Charge cleans up cached
 * charges automatically.
 *
 * We *retain* the Shop row (with uninstalledAt set) instead of deleting it so
 * that re-installs can detect prior history. Sessions, however, are deleted in
 * full because they hold OAuth credentials — not safe to keep stale.
 */
export async function markShopUninstalled(myshopifyDomain: string): Promise<void> {
  await db.$transaction([
    db.session.deleteMany({ where: { shop: myshopifyDomain } }),
    db.shop.updateMany({
      where: { myshopifyDomain },
      data: { uninstalledAt: new Date() },
    }),
    db.charge.updateMany({
      where: { shopDomain: myshopifyDomain, status: "active" },
      data: { status: "cancelled", cancelledAt: new Date() },
    }),
  ]);
}

/**
 * Latest charge for a shop, or null. Used by the dashboard to render
 * "current billing state".
 */
export async function getLatestCharge(myshopifyDomain: string) {
  return db.charge.findFirst({
    where: { shopDomain: myshopifyDomain },
    orderBy: { createdAt: "desc" },
  });
}
