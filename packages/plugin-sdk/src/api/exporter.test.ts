import * as sdk from "./exporter"
import type {
  CustomExporter,
  ExportData,
  ExportFormat,
  ExportOptions,
  ExportResult,
  PluginExportAPI,
} from "./exporter"

describe("plugin-sdk api/exporter", () => {
  it("exposes the authoring helper and plugin export API registry", () => {
    expect(typeof sdk.defineExporter).toBe("function")
    expect(typeof sdk.createExportAPI).toBe("function")
    expect(typeof sdk.clearCustomExporters).toBe("function")
  })

  it("re-exports custom exporter and export API contract types", () => {
    const assertTypes = <
      _T extends
        | CustomExporter
        | PluginExportAPI
        | ExportFormat
        | ExportOptions
        | ExportData
        | ExportResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
