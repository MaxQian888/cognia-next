import { defineConfig } from "tsup"

// Every module is a public subpath (`@cognia/agent-contracts/<module>`), so
// every non-test source file is an entry. `dts: true` is the standalone
// compile check: this package must build with no path aliases at all.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "neutral",
  target: "es2022",
  external: ["@agentclientprotocol/sdk"],
})
