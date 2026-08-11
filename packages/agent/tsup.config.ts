import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    protocol: "src/protocol.ts",
  },
  format: ["esm", "cjs"],
  target: "node20",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
})
