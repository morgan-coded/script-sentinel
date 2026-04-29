import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Slice 1 test config — intentionally small surface.
 *
 * We do NOT load the @remix-run/dev plugin here because it tries to wire up the
 * Remix dev server, which doesn't make sense for unit tests of plain server-side
 * helpers (plan detection, billing config, webhook helpers). When we add UI /
 * loader integration tests in later slices we can introduce a dedicated
 * vitest.browser config.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["app/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    globals: false,
    pool: "forks",
  },
});
