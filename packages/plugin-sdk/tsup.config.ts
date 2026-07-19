import { defineConfig } from "tsup"

const runtimeEntries = {
  index: "src/index.ts",
  manifest: "src/manifest/index.ts",
  context: "src/context/index.ts",
  contracts: "src/contracts/catalog.ts",
  events: "src/events/index.ts",
  hooks: "src/hooks/index.ts",
  permissions: "src/permissions/index.ts",
  extensions: "src/extensions/index.ts",
}

const shared = {
  target: "es2022" as const,
  platform: "neutral" as const,
}

export default defineConfig([
  {
    ...shared,
    entry: runtimeEntries,
    format: ["esm", "cjs"],
    dts: false,
    sourcemap: true,
    clean: true,
  },
  {
    ...shared,
    entry: runtimeEntries,
    format: ["esm"],
    dts: { only: true },
    clean: false,
  },
])
