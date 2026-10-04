import { defineConfig } from "tsup"

// Only the classifier runs inside the packaged Node sidecar. Bundle its pure
// provider-types constants so the staged copy needs no workspace source files.
export default defineConfig({
  entry: ["src/error-classifier.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
  noExternal: ["@cognia/provider-types"],
})
