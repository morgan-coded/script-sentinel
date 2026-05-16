import { describe, expect, it } from "vitest";
import {
  containsLikelyPII,
  scrubAddress,
  scrubCountryCode,
  scrubCustomerTags,
  scrubPostalCode,
  tagSignature,
} from "./pii";

describe("containsLikelyPII", () => {
  it("flags emails", () => {
    expect(containsLikelyPII("contact: jane.doe@example.com")).toBe(true);
    expect(containsLikelyPII("orders+plus@store.co.uk")).toBe(true);
  });

  it("flags phone numbers", () => {
    expect(containsLikelyPII("+44 20 7946 0958")).toBe(true);
    expect(containsLikelyPII("(415) 555-0142")).toBe(true);
    expect(containsLikelyPII("4155550142")).toBe(true);
  });

  it("flags name-shaped strings", () => {
    expect(containsLikelyPII("Jane Doe")).toBe(true);
    expect(containsLikelyPII("paid by John Smith via card")).toBe(true);
  });

  it("does NOT flag harmless cart text (negative cases)", () => {
    expect(containsLikelyPII("BT")).toBe(false);
    expect(containsLikelyPII("vip")).toBe(false);
    expect(containsLikelyPII("wholesale-tier-3")).toBe(false);
    expect(containsLikelyPII("US")).toBe(false);
    expect(containsLikelyPII("EUR")).toBe(false);
    expect(containsLikelyPII("M1 1AB")).toBe(false); // 5 digits — not phone
    expect(containsLikelyPII("ORDER#1234")).toBe(false);
    expect(containsLikelyPII("")).toBe(false);
    expect(containsLikelyPII(null)).toBe(false);
    expect(containsLikelyPII(undefined)).toBe(false);
  });
});

describe("scrubPostalCode", () => {
  it("returns the first 3 alphanumeric characters, uppercased", () => {
    expect(scrubPostalCode("BT12 5AA")).toBe("BT1");
    expect(scrubPostalCode("sw1a 1aa")).toBe("SW1");
    expect(scrubPostalCode("94110")).toBe("941");
    expect(scrubPostalCode("90210-1234")).toBe("902");
    expect(scrubPostalCode("75001")).toBe("750");
  });

  it("handles short codes by returning what's there", () => {
    expect(scrubPostalCode("M1")).toBe("M1");
    expect(scrubPostalCode("A1")).toBe("A1");
  });

  it("returns null for empty / undefined / non-alphanumeric-only input", () => {
    expect(scrubPostalCode(null)).toBeNull();
    expect(scrubPostalCode(undefined)).toBeNull();
    expect(scrubPostalCode("")).toBeNull();
    expect(scrubPostalCode("---")).toBeNull();
  });
});

describe("scrubCountryCode", () => {
  it("uppercases valid ISO-2 codes", () => {
    expect(scrubCountryCode("us")).toBe("US");
    expect(scrubCountryCode("GB")).toBe("GB");
    expect(scrubCountryCode("Fr")).toBe("FR");
  });

  it("rejects anything that's not exactly 2 letters", () => {
    expect(scrubCountryCode("USA")).toBeNull();
    expect(scrubCountryCode("U")).toBeNull();
    expect(scrubCountryCode("12")).toBeNull();
    expect(scrubCountryCode(null)).toBeNull();
    expect(scrubCountryCode("")).toBeNull();
  });
});

describe("scrubAddress", () => {
  it("keeps only countryCode and postalPrefix", () => {
    const result = scrubAddress({ countryCode: "GB", zip: "BT12 5AA" });
    expect(result).toEqual({ countryCode: "GB", postalPrefix: "BT1" });
  });

  it("ignores any extra fields (no PII can leak through unknown keys)", () => {
    // Confirming the function ignores unknown fields. Cast through unknown so
    // we can pass extra keys without the type system rejecting them; the
    // function's runtime behaviour is what we assert.
    const result = scrubAddress({
      countryCode: "US",
      zip: "94110",
      name: "Jane Doe",
      phone: "+1 415 555 0142",
      address1: "123 Pretend St",
    } as unknown as Parameters<typeof scrubAddress>[0]);
    expect(result).toEqual({ countryCode: "US", postalPrefix: "941" });
    expect(JSON.stringify(result)).not.toContain("Jane");
    expect(JSON.stringify(result)).not.toContain("415");
    expect(JSON.stringify(result)).not.toContain("Pretend");
  });

  it("returns nulls when the input is empty", () => {
    expect(scrubAddress({})).toEqual({ countryCode: null, postalPrefix: null });
  });
});

describe("scrubCustomerTags", () => {
  it("lowercases, normalizes punctuation, sorts, dedupes", () => {
    expect(scrubCustomerTags(["VIP", "wholesale", "vip", "Tier 1"])).toEqual([
      "tier-1",
      "vip",
      "wholesale",
    ]);
  });

  it("drops empty / whitespace-only tags", () => {
    expect(scrubCustomerTags([" ", "", null, undefined, "ok"])).toEqual(["ok"]);
  });

  it("drops PII-shaped tags (emails, phones, name-shaped)", () => {
    const result = scrubCustomerTags(["vip", "jane.doe@example.com", "+1 415 555 0142", "John Smith", "wholesale"]);
    expect(result).toEqual(["vip", "wholesale"]);
  });

  it("normalizes punctuation to dashes and collapses repeats", () => {
    expect(scrubCustomerTags(["B2B / wholesale", "vip!!!", "_keep_"])).toEqual([
      "_keep_",
      "b2b-wholesale",
      "vip",
    ]);
  });
});

describe("tagSignature", () => {
  it("joins with commas", () => {
    expect(tagSignature(["vip", "wholesale"])).toBe("vip,wholesale");
  });
  it("returns empty string for no tags", () => {
    expect(tagSignature([])).toBe("");
  });
});
