/**
 * Plugin SDK - `importer` capability surface.
 *
 * Re-exports the custom importer authoring helper and runtime plugin import
 * API used by `ctx.import.registerImporter(...)`.
 */

export { defineImporter } from "../define/define-importer"

export { clearCustomImporters, createImportAPI } from "@/lib/plugin/api/import-api"

export type {
  CustomImporter,
  ImportResult,
  ImportSource,
  PluginImportAPI,
} from "@/types/plugin/plugin-extended"
