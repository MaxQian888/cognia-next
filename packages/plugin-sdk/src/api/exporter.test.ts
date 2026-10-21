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
  it("exposes the authoring helper", () => {
    expect(typeof sdk.defineExporter).toBe("function")
  })

  it("keeps host wiring off the author surface (plugins reach it through ctx.export)", () => {
    expect(sdk).not.toHaveProperty("createExportAPI")
    expect(sdk).not.toHaveProperty("clearCustomExporters")
  })

  it("re-exports custom exporter and export API contract types", () => {
    const assertTypes = <
      _T extends
        CustomExporter | PluginExportAPI | ExportFormat | ExportOptions | ExportData | ExportResult,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
