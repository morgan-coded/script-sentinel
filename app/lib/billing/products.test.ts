import { describe, expect, it } from "vitest";
import {
  BillingInterval,
  BillingReplacementBehavior,
} from "@shopify/shopify-app-remix/server";
import {
  BILLING_PRODUCTS,
  BILLING_PRODUCT_LIST,
  buildBillingConfig,
  formatPrice,
  getProduct,
} from "./products";

describe("BILLING_PRODUCTS catalog", () => {
  it("exposes exactly the four SKUs", () => {
    expect(Object.keys(BILLING_PRODUCTS).sort()).toEqual([
      "MIGRATION_RISK_AUDIT",
      "MULTI_SCRIPT_AUDIT",
      "REGRESSION_SUITE_ALL",
      "REGRESSION_SUITE_DISCOUNT",
    ]);
  });

  it("matches the README pricing exactly", () => {
    expect(BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.amount).toBe(199);
    expect(BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.kind).toBe("one_time");

    expect(BILLING_PRODUCTS.MULTI_SCRIPT_AUDIT.amount).toBe(499);
    expect(BILLING_PRODUCTS.MULTI_SCRIPT_AUDIT.kind).toBe("one_time");

    expect(BILLING_PRODUCTS.REGRESSION_SUITE_DISCOUNT.amount).toBe(149);
    expect(BILLING_PRODUCTS.REGRESSION_SUITE_DISCOUNT.kind).toBe("recurring");

    expect(BILLING_PRODUCTS.REGRESSION_SUITE_ALL.amount).toBe(299);
    expect(BILLING_PRODUCTS.REGRESSION_SUITE_ALL.kind).toBe("recurring");
  });

  it("has zero trial days for one-time audit charges (deliverable IS the product)", () => {
    expect(BILLING_PRODUCTS.MIGRATION_RISK_AUDIT.trialDays).toBe(0);
    expect(BILLING_PRODUCTS.MULTI_SCRIPT_AUDIT.trialDays).toBe(0);
  });

  it("has 14-day trials on recurring tiers per the README", () => {
    expect(BILLING_PRODUCTS.REGRESSION_SUITE_DISCOUNT.trialDays).toBe(14);
    expect(BILLING_PRODUCTS.REGRESSION_SUITE_ALL.trialDays).toBe(14);
  });

  it("uses USD as the only currency at launch", () => {
    for (const product of BILLING_PRODUCT_LIST) {
      expect(product.currencyCode).toBe("USD");
    }
  });

  it("getProduct() returns the same object as the keyed map", () => {
    expect(getProduct("MIGRATION_RISK_AUDIT")).toBe(
      BILLING_PRODUCTS.MIGRATION_RISK_AUDIT,
    );
  });
});

describe("buildBillingConfig", () => {
  const config = buildBillingConfig();

  it("emits one entry per SKU keyed by BillingPlanKey", () => {
    expect(Object.keys(config).sort()).toEqual([
      "MIGRATION_RISK_AUDIT",
      "MULTI_SCRIPT_AUDIT",
      "REGRESSION_SUITE_ALL",
      "REGRESSION_SUITE_DISCOUNT",
    ]);
  });

  it("maps one-time products to a flat BillingInterval.OneTime entry", () => {
    expect(config.MIGRATION_RISK_AUDIT.interval).toBe(BillingInterval.OneTime);
    expect(config.MIGRATION_RISK_AUDIT.amount).toBe(199);
    expect(config.MIGRATION_RISK_AUDIT.currencyCode).toBe("USD");

    expect(config.MULTI_SCRIPT_AUDIT.interval).toBe(BillingInterval.OneTime);
    expect(config.MULTI_SCRIPT_AUDIT.amount).toBe(499);
  });

  it("maps recurring products to a subscription plan with a single Every30Days line item", () => {
    expect(config.REGRESSION_SUITE_DISCOUNT.lineItems).toHaveLength(1);
    expect(config.REGRESSION_SUITE_DISCOUNT.lineItems[0].interval).toBe(
      BillingInterval.Every30Days,
    );
    expect(config.REGRESSION_SUITE_DISCOUNT.lineItems[0].amount).toBe(149);
    expect(config.REGRESSION_SUITE_DISCOUNT.lineItems[0].currencyCode).toBe("USD");

    expect(config.REGRESSION_SUITE_ALL.lineItems).toHaveLength(1);
    expect(config.REGRESSION_SUITE_ALL.lineItems[0].amount).toBe(299);
  });

  it("only carries trialDays on recurring entries when > 0", () => {
    // One-time entries have no trialDays field at all.
    expect("trialDays" in config.MIGRATION_RISK_AUDIT).toBe(false);
    expect("trialDays" in config.MULTI_SCRIPT_AUDIT).toBe(false);
    // Recurring entries carry the 14-day trial documented in the README.
    expect(config.REGRESSION_SUITE_DISCOUNT.trialDays).toBe(14);
    expect(config.REGRESSION_SUITE_ALL.trialDays).toBe(14);
  });

  it("sets replacementBehavior STANDARD on recurring entries so $149→$299 upgrades prorate", () => {
    expect(config.REGRESSION_SUITE_DISCOUNT.replacementBehavior).toBe(
      BillingReplacementBehavior.Standard,
    );
    expect(config.REGRESSION_SUITE_ALL.replacementBehavior).toBe(
      BillingReplacementBehavior.Standard,
    );
  });

  it("never sets replacementBehavior on one-time entries (audit charges aren't replaceable)", () => {
    expect("replacementBehavior" in config.MIGRATION_RISK_AUDIT).toBe(false);
    expect("replacementBehavior" in config.MULTI_SCRIPT_AUDIT).toBe(false);
  });
});

describe("formatPrice", () => {
  it("formats one-time charges as a flat $X", () => {
    expect(formatPrice(BILLING_PRODUCTS.MIGRATION_RISK_AUDIT)).toBe("$199");
  });

  it("formats recurring charges as $X/mo", () => {
    expect(formatPrice(BILLING_PRODUCTS.REGRESSION_SUITE_DISCOUNT)).toBe("$149/mo");
  });
});
