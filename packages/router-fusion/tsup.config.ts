import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/**/*.ts", "!src/**/*.test.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2020",
  external: ["zod"],
  loader: { ".json": "json", ".md": "text", ".yaml": "text" },
})
