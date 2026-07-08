import { defineConfig } from "vitest/config";

export default defineConfig({
  root: __dirname,
  test: {
    include: ["tests/**/*.test.ts"],
    // These tests mint tokens / hit local stubs; keep them serial and patient.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
