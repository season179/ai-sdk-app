import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./"),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "lib/**/*.test.tsx", "scripts/**/*.test.ts"],
    // Pure scoring/normalization tests run without a DB; integration tests that
    // need Postgres are skipped unless DATABASE_URL is set (see pipeline.test.ts).
    environment: "node",
  },
});
