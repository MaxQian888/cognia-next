import tsupConfig from "./tsup.config"

it("builds standalone ESM, CJS, and declaration entrypoints", async () => {
  const config =
    typeof tsupConfig === "function" ? await tsupConfig({ env: {}, watch: false }) : tsupConfig
  const resolved = Array.isArray(config) ? config : [config]
  const runtime = resolved[0]
  const declarations = resolved[1]

  expect(runtime.format).toEqual(["esm", "cjs"])
  expect(runtime.dts).toBe(false)
  expect(runtime.entry).toEqual(
    expect.objectContaining({
      index: "src/index.ts",
      manifest: "src/manifest/index.ts",
      events: "src/events/index.ts",
      extensions: "src/extensions/index.ts",
    })
  )
  expect(declarations.dts).toEqual({ only: true })
  expect(declarations.entry).toEqual(runtime.entry)
  expect(
    Object.keys(runtime.entry as Record<string, string>).filter((entry) =>
      entry.startsWith("context")
    )
  ).toEqual(["context"])
})
