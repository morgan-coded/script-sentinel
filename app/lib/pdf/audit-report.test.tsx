import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AuditReportDocument } from "./audit-report";
import {
  buildAuditSnapshot,
  type ScorerInput,
} from "../audit/risk-scorer";

/**
 * PDF snapshot test.
 *
 * @react-pdf/renderer's `<Document>` is a tree of intrinsic elements (`<Page>`,
 * `<View>`, `<Text>`). Rendering that tree to HTML via React's
 * server-renderer yields a stable string we can snapshot — much more
 * meaningful than asserting on a binary PDF buffer (which differs run-to-run
 * because of font subsetting timestamps).
 *
 * If the layout intentionally changes, refresh the snapshot. The point is to
 * catch UNINTENDED drift in section ordering, copy, or risk-grade colour
 * coding — anything visible to a paying merchant.
 */

const FIXED_INPUT: ScorerInput = {
  shopName: "Acme Outdoor",
  shopDomain: "acme.myshopify.com",
  planDisplayName: "Plus",
  scope: "single",
  generatedAt: "2026-04-29T10:00:00.000Z",
  scripts: [
    {
      id: "s-vip",
      title: "VIP wholesale 20% off",
      scriptType: "line_item",
      isActive: true,
      source: `if customer && customer.tags.include?("wholesale")
  cart.line_items.each { |li| li.change_line_price(li.line_price * 0.8) }
end`,
      classification: {
        autoCategory: "b2b",
        autoConfidence: 0.95,
        autoSignals: ["customer.tags.include?"],
        overrideCategory: null,
      },
    },
    {
      id: "s-flat",
      title: "Spring 10",
      scriptType: "line_item",
      isActive: true,
      source: "cart.line_items.each { |li| li.change_line_price(li.line_price * 0.9) }",
      classification: {
        autoCategory: "discount",
        autoConfidence: 0.95,
        autoSignals: ["change_line_price"],
        overrideCategory: null,
      },
    },
  ],
  fixtures: [
    {
      id: "f-vip",
      signature: "sig-vip",
      presentmentCurrency: "USD",
      shippingCountryCode: "US",
      customerTags: ["wholesale"],
      marketSignature: "USD/US",
      observationCount: 12,
      cartTotal: 200,
      baseline: {
        totalDiscountAmount: 40,
        discountApplications: [{ type: "ScriptDiscountApplication", code: null }],
        shippingRateCode: "STANDARD",
        shippingRateAmount: 10,
        paymentGatewayNames: ["shopify_payments"],
      },
    },
    {
      id: "f-dtc",
      signature: "sig-dtc",
      presentmentCurrency: "USD",
      shippingCountryCode: "US",
      customerTags: [],
      marketSignature: "USD/US",
      observationCount: 24,
      cartTotal: 90,
      baseline: {
        totalDiscountAmount: 9,
        discountApplications: [{ type: "AutomaticDiscountApplication", code: null }],
        shippingRateCode: "STANDARD",
        shippingRateAmount: 10,
        paymentGatewayNames: ["shopify_payments"],
      },
    },
  ],
};

describe("AuditReportDocument", () => {
  it("renders a stable JSX tree for a known snapshot", () => {
    const snapshot = buildAuditSnapshot(FIXED_INPUT);
    // The JSX tree itself is stable across runs (no Date.now, no random ids
    // — the snapshot is the only timestamp source). Snapshot the
    // server-rendered string so any unintended copy or layout change shows
    // up in the diff.
    const tree = renderToString(<AuditReportDocument snapshot={snapshot} />);
    expect(tree).toMatchSnapshot();
  });

  it("renders the expected sections in the expected order", () => {
    const snapshot = buildAuditSnapshot(FIXED_INPUT);
    const tree = renderToString(<AuditReportDocument snapshot={snapshot} />);
    const indexes = [
      tree.indexOf("Executive summary"),
      tree.indexOf("Per-script breakdown"),
      tree.indexOf("Fixture-by-fixture risk table"),
      tree.indexOf("Drift alerts"),
      tree.indexOf("Migration checklist"),
    ];
    // Each must be present and in monotonically-increasing order — no
    // section may be missing, none may swap places. Drift alerts sit between
    // fixtures and checklist.
    expect(indexes.every((i) => i >= 0)).toBe(true);
    for (let i = 1; i < indexes.length; i++) {
      expect(indexes[i]).toBeGreaterThan(indexes[i - 1]);
    }
  });

  it("renders the Drift Alerts section with severity badges + recommendations", () => {
    const baseSnapshot = buildAuditSnapshot(FIXED_INPUT);
    const snapshot = {
      ...baseSnapshot,
      drift: {
        generatedAt: "2026-04-29T11:00:00.000Z",
        examined: 4,
        matched: 1,
        missing: 1,
        drift: 2,
        critical: 1,
        warning: 1,
        info: 0,
        alerts: [
          {
            fixtureSignature: "sig-critical-aaaaaaaaaaaa",
            severity: "critical" as const,
            categories: ["discount" as const],
            message: "Discount decreased by 5.00 USD.",
            recommendation: "Verify the new Function applies the same rule.",
            baseline: {
              totalDiscount: 10,
              shippingCode: "STANDARD",
              shippingAmount: 10,
              paymentGateways: ["shopify_payments"],
              cartTotal: 100,
              presentmentCurrency: "USD",
            },
            output: {
              totalDiscount: 5,
              shippingCode: "STANDARD",
              shippingAmount: 10,
              paymentGateways: ["shopify_payments"],
              cartTotal: 95,
              presentmentCurrency: "USD",
            },
          },
        ],
        missingSignatures: ["sig-untested-bbbbbbbbbb"],
      },
    };
    const tree = renderToString(<AuditReportDocument snapshot={snapshot} />);
    expect(tree).toContain("Drift alerts");
    expect(tree).toContain("CRITICAL");
    expect(tree).toContain("Discount decreased by 5.00 USD");
    expect(tree).toContain("untested in production");
  });

  it("renders an explainer when no drift summary is attached (legacy snapshot)", () => {
    const snapshot = { ...buildAuditSnapshot(FIXED_INPUT), drift: null };
    const tree = renderToString(<AuditReportDocument snapshot={snapshot} />);
    expect(tree).toContain("No drift run is attached");
  });

  it("includes the merchant's shop name and the generated-at date in the header", () => {
    const snapshot = buildAuditSnapshot(FIXED_INPUT);
    const tree = renderToString(<AuditReportDocument snapshot={snapshot} />);
    expect(tree).toContain("Acme Outdoor");
    expect(tree).toContain("acme.myshopify.com");
    expect(tree).toContain("2026-04-29");
  });

  it("escapes malicious shop names so a Script title can't break the PDF tree", () => {
    const snapshot = buildAuditSnapshot({
      ...FIXED_INPUT,
      shopName: "<script>alert(1)</script>",
      scripts: [
        {
          ...FIXED_INPUT.scripts[0],
          title: "<img src=x onerror=alert(1)>",
        },
      ],
    });
    const tree = renderToString(<AuditReportDocument snapshot={snapshot} />);
    // React's text-content escaping converts the literal `<` and `>` to
    // `&lt;` / `&gt;`. Anywhere the merchant-supplied string appears in the
    // rendered tree, the brackets are encoded — so even though substrings
    // like "onerror=alert" survive verbatim, they're inside `&lt;img …&gt;`
    // and have no executable interpretation in either an HTML viewer or
    // (more importantly) the React-PDF rendering pipeline.
    expect(tree).not.toContain("<script>alert");
    expect(tree).not.toContain("<img src=x");
    expect(tree).toContain("&lt;script&gt;");
    expect(tree).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders the empty state when no scripts are present", () => {
    const snapshot = buildAuditSnapshot({
      ...FIXED_INPUT,
      scripts: [],
      fixtures: [],
    });
    const tree = renderToString(<AuditReportDocument snapshot={snapshot} />);
    expect(tree).toContain("No scripts inventoried for this shop");
  });
});
