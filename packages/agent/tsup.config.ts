import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    "handoff-envelope": "src/handoff-envelope.ts",
    index: "src/index.ts",
    protocol: "src/protocol.ts",
    "worker-manifest": "src/worker-manifest.ts",
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
