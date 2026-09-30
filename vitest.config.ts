import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["supabase/tests/**/*.test.ts", "apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
