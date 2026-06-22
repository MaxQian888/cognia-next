/**
 * Plugin SDK helper for custom exporters.
 *
 * Pure typesafety pass-through — wrapping an exporter in `defineExporter()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `CustomExporter`. Register the result at activation via
 * `ctx.export.registerExporter(...)` so the format appears in the export menu.
 *
 * Usage:
 *   const md = defineExporter({
 *     id: "markdown-plus",
 *     name: "Markdown+",
 *     description: "Markdown with front-matter.",
 *     format: "markdown-plus",
 *     extension: "md",
 *     mimeType: "text/markdown",
 *     export: async (data) => "# ...",
 *   })
 */

import type { CustomExporter } from "@/types/plugin/plugin-extended"

export function defineExporter(exporter: CustomExporter): CustomExporter {
  return exporter
}
