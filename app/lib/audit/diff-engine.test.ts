import { describe, expect, it } from "vitest";
import {
  computeSegments,
  runDiff,
  type DiffBaselineInput,
  type DiffOutputInput,
} from "./diff-engine";

function baseline(overrides: Partial<DiffBaselineInput> = {}): DiffBaselineInput {
  return {
    fixtureSignature: "sig-1",
    totalDiscountAmount: 10,
    shippingRateCode: "STANDARD",
    shippingRateAmount: 10,
    paymentGatewayNames: ["shopify_payments"],
    cartTotal: 100,
    presentmentCurrency: "USD",
    ...overrides,
  };
}

function output(overrides: Partial<DiffOutputInput> = {}): DiffOutputInput {
  return {
    fixtureSignature: "sig-1",
    observedDiscountAmount: 10,
    observedShippingCode: "STANDARD",
    observedShippingAmount: 10,
    observedPaymentGateways: ["shopify_payments"],
    cartTotal: 100,
    presentmentCurrency: "USD",
    ...overrides,
  };
}

describe("runDiff — discount severity rules", () => {
  it("classifies a >$1 + >10% discount delta as CRITICAL", () => {
    const result = runDiff({
      baselines: [baseline({ totalDiscountAmount: 10 })],
      outputs: [output({ observedDiscountAmount: 5 })], // delta $5, rel 50%
    });
    expect(result.stats.critical).toBe(1);
    expect(result.results[0].severity).toBe("critical");
    expect(result.results[0].categories).toContain("discount");
    expect(result.results[0].message).toContain("Discount decreased");
  });

  it("classifies a $0.60 / 6% discount delta as WARNING", () => {
    const result = runDiff({
      baselines: [baseline({ totalDiscountAmount: 10 })],
      outputs: [output({ observedDiscountAmount: 9.4 })],
    });
    expect(result.stats.warning).toBe(1);
    expect(result.results[0].severity).toBe("warning");
  });

  it("classifies a tiny rounding delta as INFO", () => {
    const result = runDiff({
      baselines: [baseline({ totalDiscountAmount: 10 })],
      outputs: [output({ observedDiscountAmount: 10.01 })],
    });
    expect(result.stats.info).toBe(1);
    expect(result.results[0].severity).toBe("info");
  });

  it("treats exact discount match as no drift", () => {
    const result = runDiff({
      baselines: [baseline({ totalDiscountAmount: 10 })],
      outputs: [output({ observedDiscountAmount: 10 })],
    });
    expect(result.stats.match).toBe(1);
    expect(result.results).toHaveLength(0);
  });

  it("captures direction (increased / decreased) in the message", () => {
    const up = runDiff({
      baselines: [baseline({ totalDiscountAmount: 10 })],
      outputs: [output({ observedDiscountAmount: 30 })],
    });
    expect(up.results[0].message).toContain("increased");
    const down = runDiff({
      baselines: [baseline({ totalDiscountAmount: 10 })],
      outputs: [output({ observedDiscountAmount: 1 })],
    });
    expect(down.results[0].message).toContain("decreased");
  });
});

describe("runDiff — shipping severity rules", () => {
  it("CRITICAL when the rate disappeared in the Function output", () => {
    const result = runDiff({
      baselines: [baseline({ shippingRateCode: "EXPRESS", shippingRateAmount: 25 })],
      outputs: [output({ observedShippingCode: null, observedShippingAmount: null })],
    });
    expect(result.results[0].severity).toBe("critical");
    expect(result.results[0].message).toContain('"EXPRESS" disappeared');
    expect(result.results[0].categories).toContain("shipping");
  });

  it("CRITICAL when the rate amount delta exceeds $1", () => {
    const result = runDiff({
      baselines: [baseline({ shippingRateAmount: 10 })],
      outputs: [output({ observedShippingAmount: 12 })],
    });
    expect(result.results[0].severity).toBe("critical");
  });

  it("WARNING when the code renames but amount stays the same", () => {
    const result = runDiff({
      baselines: [baseline({ shippingRateCode: "STANDARD", shippingRateAmount: 10 })],
      outputs: [output({ observedShippingCode: "ECONOMY", observedShippingAmount: 10 })],
    });
    expect(result.results[0].severity).toBe("warning");
    expect(result.results[0].message).toContain("STANDARD");
    expect(result.results[0].message).toContain("ECONOMY");
  });

  it("INFO when Function adds a rate the baseline never had", () => {
    const result = runDiff({
      baselines: [baseline({ shippingRateCode: null, shippingRateAmount: null })],
      outputs: [output({ observedShippingCode: "EXPRESS", observedShippingAmount: 25 })],
    });
    expect(result.results[0].severity).toBe("info");
  });

  it("matches when both shipping rates are absent (digital orders)", () => {
    const result = runDiff({
      baselines: [baseline({ shippingRateCode: null, shippingRateAmount: null })],
      outputs: [output({ observedShippingCode: null, observedShippingAmount: null })],
    });
    expect(result.stats.match).toBe(1);
  });
});

describe("runDiff — payment severity rules", () => {
  it("CRITICAL when a payment gateway disappears", () => {
    const result = runDiff({
      baselines: [
        baseline({ paymentGatewayNames: ["shopify_payments", "paypal"] }),
      ],
      outputs: [output({ observedPaymentGateways: ["shopify_payments"] })],
    });
    expect(result.results[0].severity).toBe("critical");
    expect(result.results[0].message).toContain('"paypal"');
  });

  it("INFO when Function output adds a new gateway", () => {
    const result = runDiff({
      baselines: [baseline({ paymentGatewayNames: ["shopify_payments"] })],
      outputs: [
        output({ observedPaymentGateways: ["shopify_payments", "shop_pay"] }),
      ],
    });
    expect(result.results[0].severity).toBe("info");
    expect(result.results[0].message).toContain('"shop_pay"');
  });

  it("matches when gateway sets are equal regardless of order", () => {
    const result = runDiff({
      baselines: [baseline({ paymentGatewayNames: ["a", "b", "c"] })],
      outputs: [output({ observedPaymentGateways: ["c", "a", "b"] })],
    });
    expect(result.stats.match).toBe(1);
    expect(result.results).toHaveLength(0);
  });
});

describe("runDiff — cart-total drift", () => {
  it("WARNING for >5% + >$1 delta", () => {
    const result = runDiff({
      baselines: [baseline({ cartTotal: 100 })],
      outputs: [output({ cartTotal: 110 })],
    });
    // Cart-total drift on its own becomes a fixture-level warning.
    expect(result.results[0].severity).toBe("warning");
    expect(result.results[0].categories).toContain("totals");
  });

  it("INFO for sub-threshold delta", () => {
    const result = runDiff({
      baselines: [baseline({ cartTotal: 100 })],
      outputs: [output({ cartTotal: 100.4 })],
    });
    expect(result.results[0].severity).toBe("info");
  });
});

describe("runDiff — multi-category fixtures take the highest severity", () => {
  it("a fixture with discount-info + shipping-critical resolves as CRITICAL", () => {
    const result = runDiff({
      baselines: [baseline({ totalDiscountAmount: 10, shippingRateAmount: 10 })],
      outputs: [
        output({
          observedDiscountAmount: 10.01, // info
          observedShippingAmount: 50,    // critical
        }),
      ],
    });
    expect(result.results[0].severity).toBe("critical");
    expect(result.results[0].categories).toEqual(["discount", "shipping"]);
  });

  it("emits per-category messages joined in deterministic order", () => {
    const result = runDiff({
      baselines: [baseline()],
      outputs: [
        output({
          observedDiscountAmount: 5,
          observedShippingAmount: 25,
          observedPaymentGateways: [],
          cartTotal: 75,
        }),
      ],
    });
    // Order: discount → shipping → payment → totals.
    const message = result.results[0].message;
    expect(message.indexOf("Discount")).toBeLessThan(message.indexOf("Shipping rate"));
    expect(message.indexOf("Shipping rate")).toBeLessThan(message.indexOf("Payment"));
  });
});

describe("runDiff — missing FunctionOutput fallback", () => {
  it("does NOT emit a result for fixtures with no captured output", () => {
    const result = runDiff({
      baselines: [baseline({ fixtureSignature: "untested" })],
      outputs: [],
    });
    expect(result.results).toEqual([]);
    expect(result.stats.missing).toBe(1);
    expect(result.missingSignatures).toEqual(["untested"]);
  });

  it("counts missing in stats but doesn't inflate drift counts", () => {
    const result = runDiff({
      baselines: [
        baseline({ fixtureSignature: "missing-1" }),
        baseline({
          fixtureSignature: "drifted",
          totalDiscountAmount: 10,
        }),
      ],
      outputs: [
        {
          fixtureSignature: "drifted",
          observedDiscountAmount: 0,
          observedShippingCode: "STANDARD",
          observedShippingAmount: 10,
          observedPaymentGateways: ["shopify_payments"],
          cartTotal: 100,
          presentmentCurrency: "USD",
        },
      ],
    });
    expect(result.stats.fixturesExamined).toBe(2);
    expect(result.stats.missing).toBe(1);
    expect(result.stats.drift).toBe(1);
  });
});

describe("runDiff — determinism + sort order", () => {
  it("sorts results critical → warning → info, then by signature asc", () => {
    const result = runDiff({
      baselines: [
        baseline({ fixtureSignature: "z-info", totalDiscountAmount: 10 }),
        baseline({ fixtureSignature: "a-info", totalDiscountAmount: 10 }),
        baseline({ fixtureSignature: "critical-A", totalDiscountAmount: 10 }),
      ],
      outputs: [
        { ...output(), fixtureSignature: "z-info", observedDiscountAmount: 10.01 },
        { ...output(), fixtureSignature: "a-info", observedDiscountAmount: 10.01 },
        { ...output(), fixtureSignature: "critical-A", observedDiscountAmount: 1 },
      ],
    });
    expect(result.results.map((r) => r.fixtureSignature)).toEqual([
      "critical-A",
      "a-info",
      "z-info",
    ]);
  });

  it("is idempotent — same input produces the same JSON", () => {
    const input = {
      baselines: [baseline({ fixtureSignature: "dup", totalDiscountAmount: 10 })],
      outputs: [{ ...output(), fixtureSignature: "dup", observedDiscountAmount: 5 }],
    };
    expect(JSON.stringify(runDiff(input))).toBe(JSON.stringify(runDiff(input)));
  });
});

describe("runDiff — graceful empty-shop contract", () => {
  it("returns the zero state for empty inputs (slice acceptance contract)", () => {
    const result = runDiff({ baselines: [], outputs: [] });
    expect(result.results).toEqual([]);
    expect(result.stats).toEqual({
      fixturesExamined: 0,
      match: 0,
      missing: 0,
      drift: 0,
      critical: 0,
      warning: 0,
      info: 0,
    });
    expect(result.missingSignatures).toEqual([]);
  });

  it("never throws on hostile or near-empty input shapes", () => {
    expect(() =>
      runDiff({
        baselines: [],
        outputs: [
          {
            fixtureSignature: "orphan",
            observedDiscountAmount: 0,
            observedShippingCode: null,
            observedShippingAmount: null,
            observedPaymentGateways: [],
            cartTotal: 0,
            presentmentCurrency: "USD",
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("Slice 8 — segment tagging (computeSegments)", () => {
  it("emits no segment tags for a default-market, no-tags fixture", () => {
    expect(
      computeSegments({
        presentmentCurrency: "USD",
        shippingCountryCode: "US",
      }),
    ).toEqual([]);
  });

  it("emits 'b2b' when customerTags is non-empty (any tag value counts)", () => {
    expect(
      computeSegments({
        customerTags: ["wholesale"],
        presentmentCurrency: "USD",
        shippingCountryCode: "US",
      }),
    ).toEqual(["b2b"]);
  });

  it("emits 'market' for non-USD currency", () => {
    expect(
      computeSegments({
        presentmentCurrency: "EUR",
        shippingCountryCode: "DE",
      }),
    ).toEqual(["market"]);
  });

  it("emits 'market' for non-US country even when currency is USD", () => {
    expect(
      computeSegments({
        presentmentCurrency: "USD",
        shippingCountryCode: "CA",
      }),
    ).toEqual(["market"]);
  });

  it("emits both 'b2b' and 'market' in deterministic order when both apply", () => {
    expect(
      computeSegments({
        customerTags: ["vip"],
        presentmentCurrency: "EUR",
        shippingCountryCode: "DE",
      }),
    ).toEqual(["b2b", "market"]);
  });

  it("treats null shippingCountryCode as default (no market tag from country alone)", () => {
    expect(
      computeSegments({
        presentmentCurrency: "USD",
        shippingCountryCode: null,
      }),
    ).toEqual([]);
  });
});

describe("Slice 8 — runDiff appends segment tags to drift result categories", () => {
  it("appends 'b2b' to a drifted B2B fixture's categories", () => {
    const result = runDiff({
      baselines: [
        baseline({
          totalDiscountAmount: 10,
          customerTags: ["wholesale"],
        }),
      ],
      outputs: [output({ observedDiscountAmount: 0 })],
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].categories).toEqual(["discount", "b2b"]);
  });

  it("appends 'market' to a drifted non-USD fixture's categories", () => {
    const result = runDiff({
      baselines: [
        baseline({
          totalDiscountAmount: 10,
          presentmentCurrency: "EUR",
          shippingCountryCode: "DE",
        }),
      ],
      outputs: [
        output({
          observedDiscountAmount: 0,
          presentmentCurrency: "EUR",
        }),
      ],
    });
    expect(result.results[0].categories).toEqual(["discount", "market"]);
  });

  it("does NOT emit a drift result for a B2B fixture that matches exactly (segment tags never appear without behavioural drift)", () => {
    const result = runDiff({
      baselines: [
        baseline({
          totalDiscountAmount: 10,
          customerTags: ["wholesale"],
        }),
      ],
      outputs: [output({ observedDiscountAmount: 10 })],
    });
    expect(result.results).toHaveLength(0);
    expect(result.stats.match).toBe(1);
  });

  it("emits both segments in order on a multi-segment drifted fixture", () => {
    const result = runDiff({
      baselines: [
        baseline({
          totalDiscountAmount: 10,
          customerTags: ["vip"],
          presentmentCurrency: "EUR",
          shippingCountryCode: "DE",
        }),
      ],
      outputs: [
        output({
          observedDiscountAmount: 0,
          presentmentCurrency: "EUR",
        }),
      ],
    });
    expect(result.results[0].categories).toEqual(["discount", "b2b", "market"]);
  });
});
