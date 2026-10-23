import * as sdk from "./importer"
import type { CustomImporter, ImportResult, ImportSource, PluginImportAPI } from "./importer"

describe("plugin-sdk api/importer", () => {
  it("exposes the authoring helper", () => {
    expect(typeof sdk.defineImporter).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins reach it through ctx.import)", () => {
    expect(sdk).not.toHaveProperty("createImportAPI")
    expect(sdk).not.toHaveProperty("clearCustomImporters")
  })

  it("re-exports custom importer and import API contract types", () => {
    const assertTypes = <
      _T extends CustomImporter | PluginImportAPI | ImportSource | ImportResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
