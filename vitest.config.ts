import { defineConfig } from "vitest/config";

// Self-contained config so the kit's tests never inherit a surrounding
// monorepo's vitest workspace settings. The `npm test` / `npm run test:contract`
// scripts narrow this further with positional path filters.
export default defineConfig({
  test: {
    include: [
      "ppad-stub/**/*.test.ts",
      "identity-fixtures/**/*.test.ts",
      "contract-tests/**/*.test.ts",
    ],
  },
});
