import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    manifest: "src/manifest/index.ts",
    context: "src/context/index.ts",
    contracts: "src/contracts/catalog.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
  platform: "neutral",
})
