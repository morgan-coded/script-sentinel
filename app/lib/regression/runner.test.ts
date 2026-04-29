import { describe, expect, it } from "vitest";
import { detectEscalations } from "./runner.server";

describe("detectEscalations", () => {
  it("returns [] when current run has no critical/warning fixtures", () => {
    expect(
      detectEscalations({
        current: [
          { fixtureSignature: "a", severity: "info", summary: "" },
        ],
        previous: [],
      }),
    ).toEqual([]);
  });

  it("flags a fixture that goes from no-prior-row to critical (none → critical)", () => {
    const out = detectEscalations({
      current: [
        { fixtureSignature: "abc", severity: "critical", summary: "Discount dropped" },
      ],
      previous: [],
    });
    expect(out).toEqual([
      {
        fixtureSignature: "abc",
        severity: "critical",
        previousSeverity: "none",
        summary: "Discount dropped",
      },
    ]);
  });

  it("flags warning escalation (info → warning)", () => {
    const out = detectEscalations({
      current: [
        { fixtureSignature: "x", severity: "warning", summary: "Cart total drift" },
      ],
      previous: [{ fixtureSignature: "x", severity: "info" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].previousSeverity).toBe("info");
    expect(out[0].severity).toBe("warning");
  });

  it("does NOT flag a fixture whose severity stayed the same (critical → critical)", () => {
    const out = detectEscalations({
      current: [
        { fixtureSignature: "x", severity: "critical", summary: "" },
      ],
      previous: [{ fixtureSignature: "x", severity: "critical" }],
    });
    expect(out).toEqual([]);
  });

  it("does NOT flag a fixture whose severity DOWNGRADED (critical → warning)", () => {
    // The fixture got better — no alert (no regression).
    const out = detectEscalations({
      current: [
        { fixtureSignature: "x", severity: "warning", summary: "" },
      ],
      previous: [{ fixtureSignature: "x", severity: "critical" }],
    });
    expect(out).toEqual([]);
  });

  it("never emits info-level alerts (too noisy for email)", () => {
    const out = detectEscalations({
      current: [{ fixtureSignature: "x", severity: "info", summary: "rounding" }],
      previous: [],
    });
    expect(out).toEqual([]);
  });

  it("sorts results: critical first, then warning, then by fixture signature", () => {
    const out = detectEscalations({
      current: [
        { fixtureSignature: "zzz", severity: "warning", summary: "" },
        { fixtureSignature: "aaa", severity: "critical", summary: "" },
        { fixtureSignature: "mmm", severity: "warning", summary: "" },
      ],
      previous: [],
    });
    expect(out.map((o) => o.fixtureSignature)).toEqual(["aaa", "mmm", "zzz"]);
    expect(out.map((o) => o.severity)).toEqual(["critical", "warning", "warning"]);
  });
});
