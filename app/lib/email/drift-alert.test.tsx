import { describe, expect, it } from "vitest";
import { renderDriftAlertEmail } from "./drift-alert";

const SAMPLE_PROPS = {
  shopName: "Acme Plus Store",
  shopDomain: "acme.myshopify.com",
  generatedAt: "2026-04-29T08:00:00.000Z",
  dashboardUrl: "https://app.example/app/regression",
  alerts: [
    {
      fixtureSignature: "abc123def4567890",
      severity: "critical" as const,
      previousSeverity: "warning" as const,
      summary: "Discount decreased by 15.00 USD on a real cart.",
    },
    {
      fixtureSignature: "xyz789",
      severity: "warning" as const,
      previousSeverity: "none" as const,
      summary: "Shipping rate code changed.",
    },
  ],
  stats: {
    fixturesExamined: 18,
    newCritical: 1,
    newWarning: 1,
  },
};

describe("renderDriftAlertEmail", () => {
  it("renders a complete HTML document starting with <!DOCTYPE html>", () => {
    const html = renderDriftAlertEmail(SAMPLE_PROPS);
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
  });

  it("includes the shop name and domain so the merchant knows which store this alert is about", () => {
    const html = renderDriftAlertEmail(SAMPLE_PROPS);
    expect(html).toContain("Acme Plus Store");
    expect(html).toContain("acme.myshopify.com");
  });

  it("renders the headline as critical when newCritical > 0", () => {
    const html = renderDriftAlertEmail(SAMPLE_PROPS);
    expect(html).toContain("1 new critical drift");
  });

  it("falls back to warning headline when newCritical is 0 but newWarning is positive", () => {
    const html = renderDriftAlertEmail({
      ...SAMPLE_PROPS,
      alerts: [SAMPLE_PROPS.alerts[1]],
      stats: { fixturesExamined: 5, newCritical: 0, newWarning: 1 },
    });
    expect(html).toContain("1 new warning drift");
    expect(html).not.toContain("new critical drift");
  });

  it("renders one row per alert with severity, previous severity, and summary text", () => {
    const html = renderDriftAlertEmail(SAMPLE_PROPS);
    expect(html).toContain("Critical");
    expect(html).toContain("Warning");
    expect(html).toContain("(was Warning)");
    expect(html).toContain("(was Unchanged)");
    expect(html).toContain("Discount decreased by 15.00 USD on a real cart.");
    expect(html).toContain("Shipping rate code changed.");
  });

  it("renders the dashboard link with the supplied URL", () => {
    const html = renderDriftAlertEmail(SAMPLE_PROPS);
    expect(html).toContain('href="https://app.example/app/regression"');
    expect(html).toContain("Open the regression dashboard");
  });

  it("includes the YYYY-MM-DD date header (not the full ISO instant)", () => {
    const html = renderDriftAlertEmail(SAMPLE_PROPS);
    expect(html).toContain("2026-04-29");
    expect(html).not.toContain("2026-04-29T08:00:00.000Z");
  });

  it("inlines styles (no <style> blocks) so email clients don't strip them", () => {
    const html = renderDriftAlertEmail(SAMPLE_PROPS);
    expect(html).not.toMatch(/<style[\s>]/i);
    expect(html).toContain("style=");
  });
});
