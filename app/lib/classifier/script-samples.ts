/**
 * Representative Shopify Script samples for classifier tests.
 *
 * These are synthetic but follow the well-known public Shopify Script Editor
 * shapes that have been documented in Shopify help articles, partner blog
 * posts, and the Shopify Community AMA. None of them are copied from a real
 * merchant — they exist only as classifier test fixtures.
 *
 * Each entry is annotated with the category we expect the heuristic
 * classifier to land on. The classifier test asserts both the chosen category
 * and that confidence > 0.6 for the high-signal samples.
 */

import type { ClassificationCategory } from "./script-classifier";

export interface ScriptSample {
  id: string;
  description: string;
  expected: ClassificationCategory;
  /** True when the sample has strong signals (confidence should be > 0.6). */
  highSignal: boolean;
  source: string;
}

export const SCRIPT_SAMPLES: ScriptSample[] = [
  // -------------------------------------------------------------------------
  // Discount Logic — line-item discounts, BOGO, percentage off, GWP
  // -------------------------------------------------------------------------
  {
    id: "discount-flat-percent",
    description: "10% off every line item with discount message",
    expected: "discount",
    highSignal: true,
    source: `
      cart.line_items.each do |line_item|
        line_item.change_line_price(line_item.line_price * 0.9, message: "10% off")
      end
    `,
  },
  {
    id: "discount-bogo",
    description: "Buy one get one free, classic BOGO pattern",
    expected: "discount",
    highSignal: true,
    source: `
      ELIGIBLE_TAG = "bogo"
      cart.line_items.each do |line_item|
        next unless line_item.variant.product.tags.include?(ELIGIBLE_TAG)
        free_count = line_item.quantity / 2
        line_item.change_line_price(line_item.line_price - (line_item.variant.price * free_count), message: "BOGO")
      end
    `,
  },
  {
    id: "discount-tiered-spend",
    description: "Tiered discount on cart subtotal",
    expected: "discount",
    highSignal: true,
    source: `
      total = cart.subtotal_price
      tiers = [[Money.new(cents: 5000), 0.05], [Money.new(cents: 10000), 0.10]]
      tiers.each do |threshold, rate|
        next if total < threshold
        cart.line_items.each do |line_item|
          line_item.change_line_price(line_item.line_price * (1 - rate), message: "Spend more, save more")
        end
      end
    `,
  },
  {
    id: "discount-percentage-class",
    description: "Uses Shopify's PercentageDiscount helper class",
    expected: "discount",
    highSignal: true,
    source: `
      campaign = PercentageDiscount.new(15, "Spring sale")
      campaign.apply_to(:line_item, cart.line_items)
    `,
  },
  {
    id: "discount-gift-with-purchase",
    description: "Free gift line item when threshold met",
    expected: "discount",
    highSignal: true,
    source: `
      gift_sku = "GIFT-001"
      threshold = Money.new(cents: 7500)
      if cart.subtotal_price >= threshold
        gift_line = cart.line_items.find { |li| li.variant.sku == gift_sku }
        gift_line.change_line_price(Money.new(cents: 0), message: "Free gift") if gift_line
      end
    `,
  },

  // -------------------------------------------------------------------------
  // Shipping Rule
  // -------------------------------------------------------------------------
  {
    id: "shipping-postcode-block",
    description: "Suppress shipping rates for specific postcode prefixes",
    expected: "shipping",
    highSignal: true,
    source: `
      blocked_prefixes = %w[BT IM JE GY]
      zip = cart.shipping_address.zip.to_s.upcase
      if blocked_prefixes.any? { |p| zip.start_with?(p) }
        Output.shipping_rates = []
      else
        Output.shipping_rates = Input.shipping_rates
      end
    `,
  },
  {
    id: "shipping-free-over-threshold",
    description: "Free shipping over a cart total",
    expected: "shipping",
    highSignal: true,
    source: `
      threshold = Money.new(cents: 10000)
      Input.shipping_rates.each do |shipping_rate|
        next unless cart.subtotal_price >= threshold
        shipping_rate.apply_discount(shipping_rate.price, message: "Free shipping over $100")
      end
      Output.shipping_rates = Input.shipping_rates
    `,
  },
  {
    id: "shipping-rename-rate",
    description: "Rename a shipping rate label for marketing",
    expected: "shipping",
    highSignal: true,
    source: `
      Input.shipping_rates.each do |shipping_rate|
        if shipping_rate.code == "Standard"
          shipping_rate.change_name("Eco Delivery", message: "Carbon-neutral")
        end
      end
      Output.shipping_rates = Input.shipping_rates
    `,
  },
  {
    id: "shipping-remove-express",
    description: "Drop express rates for hazmat products",
    expected: "shipping",
    highSignal: true,
    source: `
      hazmat_present = cart.line_items.any? { |li| li.variant.product.tags.include?("hazmat") }
      rates_to_remove = []
      Input.shipping_rates.each do |shipping_rate|
        rates_to_remove << shipping_rate if hazmat_present && shipping_rate.code.start_with?("Express")
      end
      Output.shipping_rates = Input.shipping_rates - rates_to_remove
    `,
  },

  // -------------------------------------------------------------------------
  // Payment Customization
  // -------------------------------------------------------------------------
  {
    id: "payment-hide-cod-over-amount",
    description: "Hide cash-on-delivery over $500",
    expected: "payment",
    highSignal: true,
    source: `
      threshold = Money.new(cents: 50000)
      Output.payment_gateways = Input.payment_gateways.delete_if do |gateway|
        gateway.name.include?("Cash on Delivery") && cart.subtotal_price > threshold
      end
    `,
  },
  {
    id: "payment-reorder-gateways",
    description: "Reorder gateways to put PayPal first",
    expected: "payment",
    highSignal: true,
    source: `
      preferred, others = Input.payment_gateways.partition { |gateway| gateway.name == "PayPal" }
      Output.payment_gateways = preferred + others
    `,
  },
  {
    id: "payment-hide-bank-transfer-b2c",
    description: "Hide bank-transfer for non-B2B customers",
    expected: "payment",
    highSignal: true,
    source: `
      is_b2b = customer && customer.tags.include?("wholesale")
      Output.payment_gateways = Input.payment_gateways.delete_if do |gateway|
        gateway.name.downcase.include?("bank transfer") && !is_b2b
      end
    `,
  },

  // -------------------------------------------------------------------------
  // Market Pricing
  // -------------------------------------------------------------------------
  {
    id: "market-currency-uplift",
    description: "Boost EUR prices by 5% for FX hedge",
    expected: "market_pricing",
    highSignal: true,
    source: `
      if cart.presentment_currency == "EUR"
        cart.line_items.each do |line_item|
          uplift = line_item.line_price * 0.05
          line_item.change_line_price(line_item.line_price + uplift, message: "FX adjustment")
        end
      end
    `,
  },
  {
    id: "market-country-discount",
    description: "Country-specific welcome discount",
    expected: "market_pricing",
    highSignal: true,
    source: `
      welcome_countries = %w[FR DE NL]
      country = cart.shipping_address.country_code
      if welcome_countries.include?(country)
        cart.line_items.each do |line_item|
          line_item.change_line_price(line_item.line_price * 0.95, message: "Welcome offer")
        end
      end
    `,
  },
  {
    id: "market-presentment-rate",
    description: "Use presentment_currency_rate to normalize comparisons",
    expected: "market_pricing",
    highSignal: true,
    source: `
      base_threshold_usd = Money.new(cents: 5000)
      rate = Input.cart.presentment_currency_rate
      converted_threshold = base_threshold_usd * rate
      if cart.subtotal_price >= converted_threshold
        cart.line_items.each do |line_item|
          line_item.change_line_price(line_item.line_price * 0.9, message: "Threshold met")
        end
      end
    `,
  },

  // -------------------------------------------------------------------------
  // B2B Logic
  // -------------------------------------------------------------------------
  {
    id: "b2b-tax-exempt-discount",
    description: "Tax-exempt B2B customers get 12% off",
    expected: "b2b",
    highSignal: true,
    source: `
      if customer && customer.tax_exempt
        cart.line_items.each do |line_item|
          line_item.change_line_price(line_item.line_price * 0.88, message: "B2B price")
        end
      end
    `,
  },
  {
    id: "b2b-vip-tier-pricing",
    description: "VIP customer tag → tiered pricing override",
    expected: "b2b",
    highSignal: true,
    source: `
      tier_discounts = { "vip" => 0.20, "vip-platinum" => 0.30 }
      tier = (customer&.tags || []).find { |t| tier_discounts.key?(t) }
      if tier
        rate = tier_discounts[tier]
        cart.line_items.each do |line_item|
          line_item.change_line_price(line_item.line_price * (1 - rate), message: "VIP")
        end
      end
    `,
  },
  {
    id: "b2b-wholesale-only-products",
    description: "Block specific products for non-wholesale customers",
    expected: "b2b",
    highSignal: true,
    source: `
      is_wholesale = customer && customer.tags.include?("wholesale")
      cart.line_items.each do |line_item|
        next unless line_item.variant.product.tags.include?("wholesale-only")
        unless is_wholesale
          line_item.change_line_price(line_item.line_price * 100, message: "Restricted")
        end
      end
    `,
  },
  {
    id: "b2b-employee-pricing",
    description: "Employee tag triggers 25% off everything",
    expected: "b2b",
    highSignal: true,
    source: `
      if customer && customer.tags.include?("employee")
        cart.line_items.each do |line_item|
          line_item.change_line_price(line_item.line_price * 0.75, message: "Employee")
        end
      end
    `,
  },

  // -------------------------------------------------------------------------
  // Other / Needs Review — empty, comments-only, or genuinely ambiguous
  // -------------------------------------------------------------------------
  {
    id: "other-empty",
    description: "Empty file",
    expected: "other",
    highSignal: false,
    source: "",
  },
  {
    id: "other-comment-only",
    description: "Only a comment, no logic",
    expected: "other",
    highSignal: false,
    source: `# TODO: re-implement legacy promo before June 30, 2026`,
  },
  {
    id: "other-trivial-message",
    description: "Just sets a discount message but doesn't apply anything",
    expected: "other",
    highSignal: false,
    source: `puts "ran"`,
  },
];

/**
 * Bonus: corner-case where two categories share a signal. We expect the
 * classifier to pick the stronger bundle. Asserted in the cross-category
 * test in script-classifier.test.ts.
 */
export const CROSS_CATEGORY_SAMPLE: ScriptSample = {
  id: "b2b-and-payment",
  description:
    "Hides bank-transfer gateway only for B2B customers — shares signals between b2b and payment, but the gateway logic is dominant",
  expected: "payment",
  highSignal: true,
  source: `
    is_b2b = customer && customer.tags.include?("wholesale")
    Output.payment_gateways = Input.payment_gateways.delete_if do |gateway|
      gateway.name.downcase.include?("bank transfer") && !is_b2b
    end
  `,
};
