import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      // Measure only the pure-logic files; service.ts is an untestable CLI
      // shell (env checks + process.exit + server startup) that contains no
      // business logic beyond what is already exercised via service-core.ts.
      include: ["src/service-core.ts", "src/mcp.ts"],
      thresholds: {
        branches: 95,
        functions: 95,
        lines: 95,
        statements: 95,
      },
    },
  },
});
