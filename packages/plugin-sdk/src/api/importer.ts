/**
 * Plugin SDK - `importer` capability surface.
 *
 * Exports the custom importer authoring helper and the types behind
 * `ctx.import.registerImporter(...)`. The host builds `ctx.import`.
 */

export { defineImporter } from "../define/define-importer"

export type {
  CustomImporter,
  ImportResult,
  ImportSource,
  PluginImportAPI,
} from "@cognia/plugin-contract/types/plugin/plugin"
