import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { AppProvider } from "@shopify/polaris";
import polarisEnTranslations from "@shopify/polaris/locales/en.json";
import {
  driftCountsLine,
  fmtDay,
  fmtMoney,
  riskCountsLine,
  riskGradeBadge,
  riskGradeTone,
  severityBadge,
  severityTone,
} from "./polish-helpers";
import { SentinelEmptyState } from "../../components/SentinelEmptyState";

/**
 * Slice 7 — UI contract tests for the polish helpers.
 *
 * These don't snapshot full route output (the routes themselves are tested
 * through the persistence and Slice-specific tests). They lock the
 * tone-mapping and copy formatters so a future refactor can't silently
 * change the merchant-facing severity colours or counts strings.
 */

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <AppProvider i18n={polarisEnTranslations}>{children}</AppProvider>
);

describe("severityTone", () => {
  it("maps every DriftSeverity to a Polaris tone", () => {
    expect(severityTone("critical")).toBe("critical");
    expect(severityTone("warning")).toBe("warning");
    expect(severityTone("info")).toBe("info");
  });
});

describe("riskGradeTone", () => {
  it("maps each RiskGrade to a Polaris tone (none undefined)", () => {
    expect(riskGradeTone("high")).toBe("critical");
    expect(riskGradeTone("medium")).toBe("warning");
    expect(riskGradeTone("low")).toBe("success");
    expect(riskGradeTone("unknown")).toBe("info");
  });
});

describe("riskCountsLine", () => {
  it("formats as 'X high-risk · Y medium · Z low · W needs review'", () => {
    expect(
      riskCountsLine({ highRisk: 3, mediumRisk: 4, lowRisk: 2, unknownRisk: 1 }),
    ).toBe("3 high-risk · 4 medium · 2 low · 1 needs review");
  });

  it("never invents an aggregate score — output is just counts", () => {
    const line = riskCountsLine({
      highRisk: 0,
      mediumRisk: 0,
      lowRisk: 0,
      unknownRisk: 0,
    });
    expect(line).not.toMatch(/\d+\s*\/\s*\d+/); // forbid "87/100"-shaped strings
    expect(line).toBe("0 high-risk · 0 medium · 0 low · 0 needs review");
  });
});

describe("driftCountsLine", () => {
  it("includes match + missing alongside drift severity counts", () => {
    expect(
      driftCountsLine({
        critical: 1,
        warning: 2,
        info: 3,
        match: 10,
        missing: 4,
      }),
    ).toBe("1 critical · 2 warning · 3 info · 10 match · 4 untested");
  });
});

describe("fmtDay", () => {
  it("returns the date portion of an ISO string", () => {
    expect(fmtDay("2026-04-29T11:30:00.000Z")).toBe("2026-04-29");
  });
  it("returns '—' for null", () => {
    expect(fmtDay(null)).toBe("—");
  });
});

describe("fmtMoney", () => {
  it("formats with two decimals and ISO currency code", () => {
    expect(fmtMoney(199, "USD")).toBe("199.00 USD");
    expect(fmtMoney(0, "EUR")).toBe("0.00 EUR");
  });
});

describe("severityBadge", () => {
  it("renders an uppercase label inside a Polaris Badge", () => {
    const tree = renderToString(<Wrapper>{severityBadge("critical")}</Wrapper>);
    expect(tree).toContain("CRITICAL");
  });
});

describe("riskGradeBadge", () => {
  it("renders an uppercase risk grade label", () => {
    const tree = renderToString(<Wrapper>{riskGradeBadge("medium")}</Wrapper>);
    expect(tree).toContain("MEDIUM");
  });
});

describe("SentinelEmptyState", () => {
  it("renders the heading + optional body + optional action", () => {
    const tree = renderToString(
      <Wrapper>
        <SentinelEmptyState
          heading="Nothing here yet"
          body="Click below to get started."
          action={<span data-testid="cta">Run audit</span>}
        />
      </Wrapper>,
    );
    expect(tree).toContain("Nothing here yet");
    expect(tree).toContain("Click below to get started.");
    expect(tree).toContain("Run audit");
  });

  it("renders with just a heading (no body, no action) — minimum-viable empty state", () => {
    const tree = renderToString(
      <Wrapper>
        <SentinelEmptyState heading="Empty" />
      </Wrapper>,
    );
    expect(tree).toContain("Empty");
  });
});
