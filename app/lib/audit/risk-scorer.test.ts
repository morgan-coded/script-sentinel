import { describe, expect, it } from "vitest";
import {
  buildAuditSnapshot,
  complexityScore,
  type ScorerFixture,
  type ScorerInput,
  type ScorerScript,
} from "./risk-scorer";

function script(overrides: Partial<ScorerScript> & { id: string }): ScorerScript {
  return {
    title: overrides.title ?? "untitled",
    scriptType: overrides.scriptType ?? "line_item",
    source: overrides.source ?? "",
    isActive: overrides.isActive ?? true,
    classification: overrides.classification ?? {
      autoCategory: "discount",
      autoConfidence: 0.9,
      autoSignals: [],
      overrideCategory: null,
    },
    ...overrides,
  };
}

function fixture(overrides: Partial<ScorerFixture> & { id: string }): ScorerFixture {
  return {
    signature: "sig",
    presentmentCurrency: "USD",
    shippingCountryCode: "US",
    customerTags: [],
    marketSignature: "USD/US",
    observationCount: 1,
    cartTotal: 100,
    baseline: {
      totalDiscountAmount: 0,
      discountApplications: [],
      shippingRateCode: "STANDARD",
      shippingRateAmount: 10,
      paymentGatewayNames: ["shopify_payments"],
    },
    ...overrides,
  };
}

const baseInput = (over: Partial<ScorerInput> = {}): ScorerInput => ({
  shopName: "Acme",
  shopDomain: "acme.myshopify.com",
  planDisplayName: "Plus",
  scripts: [],
  fixtures: [],
  scope: "single",
  generatedAt: "2026-04-29T10:00:00.000Z",
  ...over,
});

describe("complexityScore", () => {
  it("returns 0 on empty input", () => {
    expect(complexityScore("")).toBe(0);
  });

  it("scales with conditional density and customer references", () => {
    const simple = "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.9) }";
    const complex = `
      if customer && customer.tags.include?("vip")
        cart.line_items.each do |li|
          if li.variant.product.tags.include?("vip-only")
            li.change_line_price(li.line_price * 0.8) unless li.line_price.zero?
          end
        end
      end
    `;
    expect(complexityScore(complex)).toBeGreaterThan(complexityScore(simple));
  });

  it("caps at 100 for pathologically large input", () => {
    const huge = Array.from({ length: 500 }, () => "if customer.tags then end").join("\n");
    expect(complexityScore(huge)).toBeLessThanOrEqual(100);
  });
});

describe("buildAuditSnapshot — risk grading (golden cases)", () => {
  it("grades a B2B/customer-tag-gated script as HIGH", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            title: "Wholesale 20% off",
            source: `
              if customer && customer.tags.include?("wholesale")
                cart.line_items.each { |li| li.change_line_price(li.line_price * 0.8) }
              end
            `,
            classification: {
              autoCategory: "b2b",
              autoConfidence: 0.95,
              autoSignals: ["customer.tags.include?"],
              overrideCategory: null,
            },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.scripts[0].riskGrade).toBe("high");
    expect(snap.counts.highRisk).toBe(1);
    expect(snap.topRisks).toHaveLength(1);
  });

  it("grades a market-pricing script as HIGH (presentment_currency)", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            source: `
              if cart.presentment_currency == "EUR"
                cart.line_items.each { |li| li.change_line_price(li.line_price * 1.05) }
              end
            `,
            classification: {
              autoCategory: "market_pricing",
              autoConfidence: 0.9,
              autoSignals: ["presentment_currency"],
              overrideCategory: null,
            },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.scripts[0].riskGrade).toBe("high");
  });

  it("grades a shipping-rate script as MEDIUM", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            source: "Output.shipping_rates = Input.shipping_rates.delete_if { |r| r.code.start_with?('Express') }",
            classification: {
              autoCategory: "shipping",
              autoConfidence: 0.95,
              autoSignals: ["Input.shipping_rates"],
              overrideCategory: null,
            },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.scripts[0].riskGrade).toBe("medium");
  });

  it("grades a simple flat-percentage discount script as LOW", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            source: "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.9) }",
            classification: {
              autoCategory: "discount",
              autoConfidence: 0.95,
              autoSignals: ["change_line_price"],
              overrideCategory: null,
            },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.scripts[0].riskGrade).toBe("low");
  });

  it("grades 'other / low confidence' scripts as UNKNOWN", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            source: "puts 'hello'",
            classification: {
              autoCategory: "other",
              autoConfidence: 0,
              autoSignals: [],
              overrideCategory: null,
            },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.scripts[0].riskGrade).toBe("unknown");
  });

  it("demotes archived scripts by one band (won't fire until reactivated)", () => {
    const archivedHigh = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            isActive: false,
            source: 'customer&.tags.include?("vip")',
            classification: {
              autoCategory: "b2b",
              autoConfidence: 0.95,
              autoSignals: [],
              overrideCategory: null,
            },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(archivedHigh.scripts[0].riskGrade).toBe("medium");
    expect(archivedHigh.scripts[0].riskReasons.some((r) => r.includes("archived"))).toBe(true);
  });

  it("falls back to UNKNOWN when no fixtures are available even for low-risk scripts", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            source: "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.9) }",
            classification: {
              autoCategory: "discount",
              autoConfidence: 0.95,
              autoSignals: [],
              overrideCategory: null,
            },
          }),
        ],
        fixtures: [],
      }),
    );
    // With zero fixtures we promote a "low" → "unknown" so the merchant
    // doesn't see a falsely confident grade before fixtures land.
    expect(snap.scripts[0].riskGrade).toBe("unknown");
    expect(snap.scripts[0].riskReasons.some((r) => r.includes("No cart fixtures"))).toBe(true);
  });
});

describe("buildAuditSnapshot — overall structure", () => {
  it("emits the executive-summary counts and top-3 risks", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "h1",
            title: "Wholesale tier",
            source: 'if customer&.tags.include?("wholesale") then end',
            classification: { autoCategory: "b2b", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
          script({
            id: "h2",
            title: "EU pricing",
            source: 'cart.presentment_currency == "EUR"',
            classification: { autoCategory: "market_pricing", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
          script({
            id: "h3",
            title: "VIP gates",
            source: 'customer.b2b? && customer.tax_exempt',
            classification: { autoCategory: "b2b", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
          script({
            id: "h4",
            title: "Extra wholesale",
            source: 'customer&.tags.include?("wholesale-platinum")',
            classification: { autoCategory: "b2b", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
          script({
            id: "l1",
            title: "Flat 10",
            source: "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.9) }",
            classification: { autoCategory: "discount", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.counts.scripts).toBe(5);
    expect(snap.counts.highRisk).toBe(4);
    // top3 caps at 3 even with 4 high-risk scripts.
    expect(snap.topRisks).toHaveLength(3);
    expect(snap.topRisks.map((r) => r.scriptId)).toEqual(["h1", "h2", "h3"]);
  });

  it("produces a checklist ranked by risk grade then complexity (deterministic)", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "low",
            title: "Z low",
            source: "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.9) }",
            classification: { autoCategory: "discount", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
          script({
            id: "high",
            title: "A high",
            source: 'customer&.tags.include?("wholesale")',
            classification: { autoCategory: "b2b", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.checklist).toHaveLength(2);
    expect(snap.checklist[0].rank).toBe(1);
    expect(snap.checklist[0].scriptId).toBe("high");
    expect(snap.checklist[1].scriptId).toBe("low");
  });

  it("surfaces open questions for low-confidence and metafield-using scripts", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            title: "Mystery",
            source: "puts 'no signals'",
            classification: { autoCategory: "other", autoConfidence: 0, autoSignals: [], overrideCategory: null },
          }),
          script({
            id: "s2",
            title: "Metafield gate",
            source: 'customer&.metafields("custom").size',
            classification: { autoCategory: "b2b", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
        ],
        fixtures: [fixture({ id: "f1" })],
      }),
    );
    expect(snap.openQuestions.length).toBeGreaterThanOrEqual(2);
    expect(snap.openQuestions.some((q) => q.scriptId === "s1")).toBe(true);
    expect(snap.openQuestions.some((q) => q.scriptId === "s2" && q.question.includes("metafields"))).toBe(true);
  });

  it("annotates fixtures with baseline notes and migration risks", () => {
    const snap = buildAuditSnapshot(
      baseInput({
        scripts: [
          script({
            id: "s1",
            source: 'customer&.tags.include?("vip")',
            classification: { autoCategory: "b2b", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
          }),
        ],
        fixtures: [
          fixture({
            id: "f-high",
            customerTags: ["vip"],
            observationCount: 12,
            baseline: {
              totalDiscountAmount: 25,
              discountApplications: [{ type: "DiscountCodeApplication", code: "VIP25" }],
              shippingRateCode: "EXPRESS",
              shippingRateAmount: 15,
              paymentGatewayNames: ["shopify_payments"],
            },
          }),
        ],
      }),
    );
    expect(snap.fixtures[0].migrationRisks.some((r) => r.includes("vip"))).toBe(true);
    expect(snap.fixtures[0].migrationRisks.some((r) => r.includes("12 historical orders"))).toBe(true);
    expect(snap.fixtures[0].baselineNotes.some((n) => n.includes("Discount of 25.00"))).toBe(true);
  });

  it("is deterministic — same input produces byte-identical snapshot", () => {
    const input = baseInput({
      scripts: [
        script({
          id: "s1",
          source: 'customer&.tags.include?("wholesale")',
          classification: { autoCategory: "b2b", autoConfidence: 0.9, autoSignals: [], overrideCategory: null },
        }),
      ],
      fixtures: [fixture({ id: "f1" })],
    });
    const a = JSON.stringify(buildAuditSnapshot(input));
    const b = JSON.stringify(buildAuditSnapshot(input));
    expect(a).toBe(b);
  });
});
