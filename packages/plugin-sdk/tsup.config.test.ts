import tsupConfig from "./tsup.config"

it("builds standalone ESM, CJS, and declaration entrypoints", async () => {
  const config =
    typeof tsupConfig === "function" ? await tsupConfig({ env: {}, watch: false }) : tsupConfig
  const resolved = Array.isArray(config) ? config[0] : config

  expect(resolved.format).toEqual(["esm", "cjs"])
  expect(resolved.dts).toBe(true)
  expect(resolved.entry).toEqual(
    expect.objectContaining({ index: "src/index.ts", manifest: "src/manifest/index.ts" })
  )
})
