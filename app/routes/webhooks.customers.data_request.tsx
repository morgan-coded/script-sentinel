import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR mandatory webhook: `customers/data_request`.
 *
 * Shopify fires this when a merchant requests a copy of a customer's data on
 * the customer's behalf (Article 15 right of access). Apps that store
 * customer data must respond by sending the data to the merchant out-of-band.
 *
 * Script Sentinel does NOT store customer-identifying data. The Slice 3 PII
 * contract (enforced by `app/lib/fixtures/pii.ts`, the extractor, and the
 * fixtures-persistence tripwire test) strips names, emails, phones, and full
 * addresses before any persistence. Order rows are processed transiently and
 * never written; the only retained fields are deduped cart compositions
 * (variant ids + quantities), market signature (currency + ISO-2 country),
 * and a 3-character postal prefix. None of those identify a specific person.
 *
 * Therefore: log the request for our audit trail and return 200. Shopify
 * accepts a 200-only response when the app holds no customer data.
 *
 * The `authenticate.webhook(request)` call performs HMAC-SHA256 verification
 * against `process.env.SHOPIFY_API_SECRET`. Forged requests throw before any
 * code below this line runs.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const customerId =
    (payload as { customer?: { id?: string | number } } | null)?.customer?.id ?? "unknown";
  console.log(
    `[GDPR ${topic}] shop=${shop} customer=${customerId} — no customer data stored; acknowledged.`,
  );
  return new Response();
};
