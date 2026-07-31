import * as sdk from "./importer"
import type { CustomImporter, ImportResult, ImportSource, PluginImportAPI } from "./importer"

describe("plugin-sdk api/importer", () => {
  it("exposes the authoring helper and plugin import API registry", () => {
    expect(typeof sdk.defineImporter).toBe("function")
    expect(typeof sdk.createImportAPI).toBe("function")
    expect(typeof sdk.clearCustomImporters).toBe("function")
  })

  it("re-exports custom importer and import API contract types", () => {
    const assertTypes = <
      _T extends CustomImporter | PluginImportAPI | ImportSource | ImportResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
