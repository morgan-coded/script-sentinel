import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { markShopUninstalled } from "../lib/shopify/shop.server";

/**
 * Handler for the `app/uninstalled` topic.
 *
 * `authenticate.webhook(request)` performs the HMAC-SHA256 signature check
 * against process.env.SHOPIFY_API_SECRET. Forged or stale requests throw
 * before the action body runs, so any code below this line has been verified
 * by Shopify's signing infrastructure.
 *
 * This handler is idempotent: webhooks can fire multiple times, and a
 * subsequent fire after the session has been deleted should still succeed.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (session) {
    await markShopUninstalled(shop);
  }

  return new Response();
};
