import { defineConfig } from "tsup"
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "neutral",
  target: "es2022",
  external: [/^@cognia\//],
})
