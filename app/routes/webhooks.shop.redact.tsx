import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * GDPR mandatory webhook: `shop/redact`.
 *
 * Shopify fires this 48 hours after a shop uninstalls Script Sentinel. Apps
 * are required to delete all merchant data within 30 days; we do it
 * immediately so there's no retention window to manage.
 *
 * Distinct from `app/uninstalled` (handled in `webhooks.app.uninstalled.tsx`):
 *   - `app/uninstalled` keeps the Shop row with `uninstalledAt` set so a
 *     re-install can detect prior history. Sessions are dropped because
 *     they hold OAuth credentials.
 *   - `shop/redact` (this handler) hard-deletes the Shop row. Every related
 *     model (DiscoveredScript, CartFixture, FixtureBaseline, AuditPurchase,
 *     AuditReport, DiscoveredFunction, CaptureRun, FunctionOutput, DriftRun,
 *     DriftResult, RegressionRun, DriftAlert, Charge) is declared with
 *     `onDelete: Cascade` against the Shop FK, so a single delete on Shop
 *     purges every row keyed to the merchant.
 *
 * Idempotent: if `app/uninstalled` already deleted the sessions, the
 * second deleteMany is a no-op. If the Shop row no longer exists (re-fired
 * webhook), `delete` would throw — we use `deleteMany` for the same idempotent
 * semantic.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  await db.$transaction([
    db.session.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { myshopifyDomain: shop } }),
  ]);

  console.log(`[GDPR ${topic}] shop=${shop} — shop + sessions purged; cascade removed all related rows.`);
  return new Response();
};
