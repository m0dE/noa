import { defineConfig } from "vitest/config";

/** Live runs against paid APIs (test/manual/*.live.ts); never part of `pnpm test`. */
export default defineConfig({
  test: { include: ["test/manual/**/*.live.ts"], environment: "node", testTimeout: 600_000 },
});
