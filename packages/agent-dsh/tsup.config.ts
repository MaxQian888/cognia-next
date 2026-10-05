import { defineConfig } from "tsup"

// Every module is a public subpath. `dts: true` is the standalone compile
// check; sibling `@cognia/*` packages stay external (declared dependencies).
export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  platform: "neutral",
  target: "es2022",
  external: [/^@cognia\//, "zod"],
})
