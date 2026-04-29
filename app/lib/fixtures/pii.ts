/**
 * PII scrubber for cart-fixture extraction.
 *
 * Slice 3 must never persist customer-identifying fields. The architectural
 * commitment in the README is:
 *
 *   "Strip customer names, emails, phone numbers, addresses (keep country
 *    + postal code prefix only). Document this prominently for App Store
 *    privacy review."
 *
 * This module is pure — no I/O, no Prisma. The extractor runs every cart
 * composition through `scrubAddress` and `scrubCustomerTags` before persistence,
 * and the persistence test asserts that `containsLikelyPII` returns false for
 * every stored row.
 */

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Phone match. Tightened to avoid false-positives on ISO timestamps like
// "2026-04-15T10:00:00Z" which used to look like a phone number under a more
// generous regex. Now requires one of:
//   - explicit `+` prefix followed by digits + separators (e.g. "+44 20 7946 0958")
//   - parenthesized US-style format (e.g. "(415) 555-0142")
//   - 10+ CONTIGUOUS digits with no separators (e.g. "4155550142")
// ISO dates have hyphens at fixed positions and only 8 digits across 10 chars,
// so they slip through cleanly.
const PHONE_RE =
  /\+\d[\d\s().-]{6,}\d|\(\d{3}\)[\s.-]?\d{3}[\s.-]?\d{4}|\d{10,}/;
// A "name-like" string is two or more capitalized words separated by spaces.
// Used as a defense-in-depth check — we don't try to FIX names, we just refuse
// to persist anything that looks like one.
const NAME_LIKE_RE = /\b[A-Z][a-z]{1,}\s+[A-Z][a-z]{1,}\b/;

/**
 * Truthy iff the string contains an email, phone, or name-shaped substring.
 * Used by tests as a tripwire on every persisted row.
 */
export function containsLikelyPII(value: string | null | undefined): boolean {
  if (!value) return false;
  if (EMAIL_RE.test(value)) return true;
  if (PHONE_RE.test(value)) return true;
  if (NAME_LIKE_RE.test(value)) return true;
  return false;
}

/**
 * Reduce a postal code to its first 3 characters, uppercased, alphanumeric
 * only. Postcodes are a notorious gray zone — UK postcodes can identify a
 * city block, but the first three characters identify a region (BT = Belfast,
 * SW1 = Westminster). The 3-prefix rule is the floor we promise to merchants.
 *
 * Examples:
 *   "BT12 5AA" → "BT1"
 *   "94110"    → "941"
 *   "M1 1AB"   → "M1"   (only 2 alphanumeric chars; we keep what we have)
 *   ""         → null
 *   undefined  → null
 */
export function scrubPostalCode(zip: string | null | undefined): string | null {
  if (!zip) return null;
  const cleaned = zip.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, 3);
}

/**
 * Coerce an ISO-2 country code to an upper-case 2-letter string, or null.
 * Anything that doesn't look like a country code (length, alpha-only) is
 * dropped.
 */
export function scrubCountryCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const cleaned = code.toUpperCase();
  return /^[A-Z]{2}$/.test(cleaned) ? cleaned : null;
}

export interface ScrubbedAddress {
  countryCode: string | null;
  postalPrefix: string | null;
}

/**
 * Strip a Shopify MailingAddress down to the only two fields we keep:
 * `countryCode` and `postalPrefix`. Names, lines, city, phone, email are
 * dropped entirely.
 */
export function scrubAddress(input: {
  countryCode?: string | null;
  zip?: string | null;
  // Anything else is intentionally ignored — even if Shopify adds new fields,
  // the scrubber is closed against new PII vectors.
}): ScrubbedAddress {
  return {
    countryCode: scrubCountryCode(input.countryCode),
    postalPrefix: scrubPostalCode(input.zip),
  };
}

/**
 * Filter customer tags to a normalized, non-PII set:
 *   - lowercased
 *   - whitespace and punctuation stripped to a-z, 0-9, dash, underscore
 *   - empty results dropped
 *   - tags that look like emails / phones / names (e.g. "Acme John Smith")
 *     are dropped — merchants sometimes mis-tag customers with raw PII
 *   - sorted + deduplicated for deterministic dedup signatures
 */
export function scrubCustomerTags(input: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const raw of input) {
    if (!raw) continue;
    const trimmed = raw.trim();
    if (containsLikelyPII(trimmed)) continue;
    const normalized = trimmed.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (normalized.length === 0) continue;
    out.add(normalized);
  }
  return [...out].sort();
}

/**
 * Compose the comma-joined "tag signature" used by dedup. Stable: same input
 * order → same output. Empty input → empty string (matches the model default).
 */
export function tagSignature(tags: ReadonlyArray<string>): string {
  return tags.join(",");
}
