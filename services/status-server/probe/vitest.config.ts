import { defineConfig } from "vitest/config"

// Unit and local-integration suites. They never touch the network beyond
// loopback servers the tests start themselves; the opt-in public run lives in
// `vitest.live.config.ts` (`pnpm test:live`).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.live.test.ts", "node_modules/**", "dist/**"],
    testTimeout: 20_000,
  },
})
