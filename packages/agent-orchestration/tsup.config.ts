import { defineConfig } from "tsup"

// Every module is a public subpath (`@cognia/agent-orchestration/<module>`).
// `dts: true` is the standalone compile check: no host path aliases exist here.
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "neutral",
  target: "es2022",
})
