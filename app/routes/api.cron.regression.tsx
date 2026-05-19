import type { LoaderFunctionArgs } from "@remix-run/node";
import db from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runRegressionForShop } from "../lib/regression/runner.server";
import { renderDriftAlertEmail } from "../lib/email/drift-alert";
import { fetchActiveSubscription } from "../lib/billing/subscription";

/**
 * Slice 7 — Continuous Regression cron handler.
 *
 * External scheduler hits `GET /api/cron/regression` nightly with
 * `Authorization: Bearer ${CRON_SECRET}`. The handler iterates every
 * non-uninstalled shop, re-runs the diff engine via the regression runner,
 * detects new alerts (escalations vs. the previous run), and renders the
 * drift-alert email HTML for any new critical/warning alerts.
 *
 * Slice 7 v1 RENDERS the email and logs it — actual delivery is left to the
 * deployer's mail provider (Resend / SES / SendGrid). Once a sender is
 * wired, mark the alert dispatched via `markAlertsDispatched`.
 *
 * No write scopes are touched. The cron makes one read-only Admin API
 * call per shop — the per-shop subscription check via
 * `unauthenticated.admin(shop)` + `currentAppInstallation.activeSubscriptions`
 * — and skips shops without an active Drift Monitor subscription.
 * Capture refresh (re-pulling orders into FunctionOutput rows) stays a
 * merchant-driven action — see the README's Slice 7 honest-limitations note.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return new Response("Cron not configured (missing CRON_SECRET)", {
      status: 503,
    });
  }
  const authz = request.headers.get("authorization") ?? "";
  if (authz !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const shops = await db.shop.findMany({
    where: { uninstalledAt: null, isPlus: true },
    select: { myshopifyDomain: true, shopName: true },
  });

  const url = new URL(request.url);
  const dashboardUrl = `${url.origin}/app/regression`;

  const results: Array<{
    shopDomain: string;
    status: "ok" | "error" | "skipped";
    reason?: "no_subscription" | "no_session";
    regressionRunId?: string;
    newCritical?: number;
    newWarning?: number;
    emailRendered?: boolean;
    error?: string;
  }> = [];

  for (const shop of shops) {
    try {
      // Codex review-response: only paying merchants get cron-driven runs.
      // Per-shop subscription check via the offline-token admin client; if
      // no offline session exists yet (shop installed but never opened the
      // dashboard) we skip rather than crash.
      let subscription: Awaited<ReturnType<typeof fetchActiveSubscription>> = null;
      try {
        const { admin } = await unauthenticated.admin(shop.myshopifyDomain);
        subscription = await fetchActiveSubscription(admin);
      } catch {
        results.push({
          shopDomain: shop.myshopifyDomain,
          status: "skipped",
          reason: "no_session",
        });
        continue;
      }
      if (!subscription) {
        results.push({
          shopDomain: shop.myshopifyDomain,
          status: "skipped",
          reason: "no_subscription",
        });
        continue;
      }

      const outcome = await runRegressionForShop(shop.myshopifyDomain, "cron");
      let emailRendered = false;
      if (outcome.alerts.length > 0) {
        const html = renderDriftAlertEmail({
          shopName: shop.shopName ?? shop.myshopifyDomain,
          shopDomain: shop.myshopifyDomain,
          generatedAt: new Date().toISOString(),
          alerts: outcome.alerts.map((a) => ({
            fixtureSignature: a.fixtureSignature,
            severity: a.severity,
            previousSeverity: a.previousSeverity,
            summary: a.summary,
          })),
          dashboardUrl,
          stats: {
            fixturesExamined: outcome.stats.fixturesExamined,
            newCritical: outcome.stats.newCritical,
            newWarning: outcome.stats.newWarning,
          },
        });
        emailRendered = true;
        // Slice 7 v1 — log the rendered email for the deployer's mail service
        // to forward. Length-only log line keeps secrets out of stdout but
        // proves the render succeeded.
        console.log(
          `[regression cron] ${shop.myshopifyDomain}: rendered drift-alert email (${html.length} bytes, ${outcome.alerts.length} alerts)`,
        );
      }
      results.push({
        shopDomain: shop.myshopifyDomain,
        status: "ok",
        regressionRunId: outcome.regressionRunId,
        newCritical: outcome.stats.newCritical,
        newWarning: outcome.stats.newWarning,
        emailRendered,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        `[regression cron] ${shop.myshopifyDomain}: failed — ${message}`,
      );
      results.push({
        shopDomain: shop.myshopifyDomain,
        status: "error",
        error: message,
      });
    }
  }

  return Response.json({
    ranAt: new Date().toISOString(),
    shopsConsidered: shops.length,
    results,
  });
};
