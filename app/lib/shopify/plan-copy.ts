/**
 * Plan-related copy that needs to be safe to import from client components.
 *
 * Kept separate from `plan.server.ts` because Remix's `.server.*` suffix marks
 * a module as server-only and bans importing it from non-loader/action code.
 * The gate copy itself is rendered inside a React component (the non-Plus
 * fallback path), so it has to live in a client-safe module.
 */

export const NON_PLUS_GATE_MESSAGE =
  "Script Sentinel is for Shopify Plus merchants. Shopify Scripts only run on Plus stores.";
