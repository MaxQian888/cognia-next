/**
 * Plugin SDK - `exporter` capability surface.
 *
 * Exports the custom exporter authoring helper and the types behind
 * `ctx.export.registerExporter(...)`. The host builds `ctx.export`.
 */

export { defineExporter } from "../define/define-exporter"

export type {
  CustomExporter,
  ExportData,
  ExportFormat,
  ExportOptions,
  ExportResult,
  PluginExportAPI,
} from "@cognia/plugin-contract/types/plugin/plugin"
