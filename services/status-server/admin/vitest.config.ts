import { defineConfig } from "vitest/config"

// Pure unit suites: every HTTP call goes to an injected fake fetch and the
// Access token comes from an injected environment / command runner.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
  },
})
