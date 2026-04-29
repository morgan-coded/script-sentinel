import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR mandatory webhook: `customers/redact`.
 *
 * Shopify fires this 10 days after a merchant flags a customer for erasure
 * (Article 17 right to erasure). Apps that store customer data must delete
 * any retained personal data for that customer.
 *
 * Script Sentinel does NOT store customer-identifying data. See
 * `webhooks.customers.data_request.tsx` for the full PII contract; the
 * short version is that fixtures retain only deduped cart compositions and
 * non-identifying market signatures, never customer names/emails/phones/
 * addresses. There is nothing to redact at the customer level.
 *
 * Therefore: log the request and return 200. The Slice 3 PII tripwire test
 * (`test/fixtures.persistence.test.ts`) is the load-bearing guarantee that
 * this remains true on every future change.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const customerId =
    (payload as { customer?: { id?: string | number } } | null)?.customer?.id ?? "unknown";
  console.log(
    `[GDPR ${topic}] shop=${shop} customer=${customerId} — no customer data stored; nothing to redact.`,
  );
  return new Response();
};
