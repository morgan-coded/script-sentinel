/**
 * Script Sentinel billing catalog.
 *
 * Single source of truth for the Shopify Managed Billing SKUs. Used by:
 *   - shopify.server.ts to produce the BillingConfig passed to shopifyApp({})
 *   - dashboard / paywall routes to render copy + CTAs
 *   - Audit paywall to start a one-time charge
 *   - Regression-suite subscription to start a recurring charge
 *
 * Pricing comes from the product README. Only Shopify Managed Billing is supported
 * (App Store apps must use it). USD-only at launch.
 */
import {
  BillingInterval,
  BillingReplacementBehavior,
} from "@shopify/shopify-app-remix/server";

export const CURRENCY = "USD" as const;

export type BillingPlanKey =
  | "MIGRATION_RISK_AUDIT"
  | "MULTI_SCRIPT_AUDIT"
  | "REGRESSION_SUITE_DISCOUNT"
  | "REGRESSION_SUITE_ALL";

export type ChargeKind = "one_time" | "recurring";

export interface BillingProduct {
  /** Stable internal key. Also used as the Shopify Managed Billing plan name. */
  key: BillingPlanKey;
  /** Human-readable product name surfaced in the dashboard and Partners admin. */
  displayName: string;
  /** "one_time" or "recurring" — drives interval selection downstream. */
  kind: ChargeKind;
  /** Amount in major currency units (e.g. 199 means $199.00). */
  amount: number;
  /** ISO-4217 currency code. USD-only at launch. */
  currencyCode: typeof CURRENCY;
  /** Optional trial in days. Audit products MUST be 0 (deliverable IS the product). */
  trialDays: number;
  /** Short marketing description for paywall/dashboard copy. */
  description: string;
}

export const BILLING_PRODUCTS: Readonly<Record<BillingPlanKey, BillingProduct>> = Object.freeze({
  MIGRATION_RISK_AUDIT: {
    key: "MIGRATION_RISK_AUDIT",
    displayName: "Migration Risk Audit",
    kind: "one_time",
    amount: 99,
    currencyCode: CURRENCY,
    trialDays: 0,
    description:
      "Launch-price audit of a single Script family (discount, shipping, payment, or market pricing) with a Migration Risk PDF.",
  },
  MULTI_SCRIPT_AUDIT: {
    key: "MULTI_SCRIPT_AUDIT",
    displayName: "Multi-Script Audit",
    kind: "one_time",
    amount: 299,
    currencyCode: CURRENCY,
    trialDays: 0,
    description:
      "Launch-price audit covering every active Script family on the store. Single consolidated Migration Risk PDF.",
  },
  REGRESSION_SUITE_DISCOUNT: {
    key: "REGRESSION_SUITE_DISCOUNT",
    displayName: "Drift Monitor",
    kind: "recurring",
    amount: 149,
    currencyCode: CURRENCY,
    trialDays: 14,
    description:
      "Ongoing parity checks after an audit. Nightly drift alerts compare captured Function outputs against the fixture baseline.",
  },
  REGRESSION_SUITE_ALL: {
    key: "REGRESSION_SUITE_ALL",
    displayName: "Legacy All Rules Suite",
    kind: "recurring",
    amount: 299,
    currencyCode: CURRENCY,
    trialDays: 14,
    description:
      "Legacy recurring plan retained for existing customers who need all customization types.",
  },
});

export const BILLING_PRODUCT_LIST: ReadonlyArray<BillingProduct> = Object.freeze(
  Object.values(BILLING_PRODUCTS),
);

export function getProduct(key: BillingPlanKey): BillingProduct {
  return BILLING_PRODUCTS[key];
}

/**
 * Build the `billing` config object for `shopifyApp({})`.
 *
 * Shape mirrors @shopify/shopify-api `BillingConfig`:
 *   - One-time plan:    { amount, currencyCode, interval: OneTime }
 *   - Subscription plan: { trialDays?, replacementBehavior?, lineItems: [{ amount, currencyCode, interval: Every30Days }] }
 *
 * The library models recurring billing as a plan with one or more `lineItems`,
 * NOT a flat `{interval, amount}`. The catalog uses a single line item per plan;
 * multi-line tiers are not in scope.
 *
 * Each entry is keyed by the plan name — we reuse the BillingPlanKey string so
 * `billing.require({ plans: [BILLING_PRODUCTS.X.key] })` stays typed end-to-end.
 */
export type OneTimeBillingEntry = {
  amount: number;
  currencyCode: string;
  interval: typeof BillingInterval.OneTime;
};
export type RecurringBillingEntry = {
  trialDays?: number;
  /**
   * `STANDARD` enables prorated upgrades. When a $149/mo
   * subscriber selects the legacy $299/mo tier, Shopify Managed Billing replaces
   * the existing subscription and credits the unused portion of the old
   * one against the new charge. Without this field, the upgrade either
   * fails outright or double-charges depending on the merchant's plan
   * state.
   */
  replacementBehavior?: BillingReplacementBehavior;
  lineItems: Array<{
    amount: number;
    currencyCode: string;
    interval: typeof BillingInterval.Every30Days;
  }>;
};

function oneTime(product: BillingProduct): OneTimeBillingEntry {
  return {
    amount: product.amount,
    currencyCode: product.currencyCode,
    interval: BillingInterval.OneTime,
  };
}

function recurring(product: BillingProduct): RecurringBillingEntry {
  const entry: RecurringBillingEntry = {
    // Prorated tier upgrades ($149 ↔ $299) ride on STANDARD; any other
    // value would either fail mid-cycle or double-charge.
    replacementBehavior: BillingReplacementBehavior.Standard,
    lineItems: [
      {
        amount: product.amount,
        currencyCode: product.currencyCode,
        interval: BillingInterval.Every30Days,
      },
    ],
  };
  if (product.trialDays > 0) entry.trialDays = product.trialDays;
  return entry;
}

/**
 * The Shopify `BillingConfig` type is `{ [planName: string]: BillingConfigItem }`
 * — i.e. it requires an index signature, not a closed record. We declare a
 * compatible shape with the index signature satisfied while still typing each
 * known plan precisely so call sites can still narrow on the literal key.
 */
export type SentinelBillingConfig = {
  [planName: string]: OneTimeBillingEntry | RecurringBillingEntry;
} & {
  MIGRATION_RISK_AUDIT: OneTimeBillingEntry;
  MULTI_SCRIPT_AUDIT: OneTimeBillingEntry;
  REGRESSION_SUITE_DISCOUNT: RecurringBillingEntry;
  REGRESSION_SUITE_ALL: RecurringBillingEntry;
};

export function buildBillingConfig(): SentinelBillingConfig {
  return {
    MIGRATION_RISK_AUDIT: oneTime(BILLING_PRODUCTS.MIGRATION_RISK_AUDIT),
    MULTI_SCRIPT_AUDIT: oneTime(BILLING_PRODUCTS.MULTI_SCRIPT_AUDIT),
    REGRESSION_SUITE_DISCOUNT: recurring(
      BILLING_PRODUCTS.REGRESSION_SUITE_DISCOUNT,
    ),
    REGRESSION_SUITE_ALL: recurring(BILLING_PRODUCTS.REGRESSION_SUITE_ALL),
  };
}

/** Format a price for UI rendering. */
export function formatPrice(product: BillingProduct): string {
  const base = `$${product.amount}`;
  return product.kind === "recurring" ? `${base}/mo` : base;
}
