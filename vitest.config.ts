import { defineConfig } from "vitest/config";

export default defineConfig({
  assetsInclude: ["**/*.html"],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**", "tests/worker/**/*.test.ts"],
  },
});
