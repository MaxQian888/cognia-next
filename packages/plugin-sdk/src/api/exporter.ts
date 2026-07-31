/**
 * Plugin SDK - `exporter` capability surface.
 *
 * Re-exports the custom exporter authoring helper and runtime plugin export
 * API used by `ctx.export.registerExporter(...)`.
 */

export { defineExporter } from "../define/define-exporter"

export { clearCustomExporters, createExportAPI } from "@/lib/plugin/api/export-api"

export type {
  CustomExporter,
  ExportData,
  ExportFormat,
  ExportOptions,
  ExportResult,
  PluginExportAPI,
} from "@/types/plugin/plugin"
