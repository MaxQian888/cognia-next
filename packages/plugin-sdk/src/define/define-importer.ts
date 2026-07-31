/**
 * Plugin SDK helper for content importers (the `importers` capability).
 *
 * Pure typesafety pass-through — wrapping an importer in `defineImporter()`
 * gives plugin authors autocomplete and a compile-time check that the shape
 * matches `CustomImporter`. Register the result at activation via
 * `ctx.import.registerImporter(...)` so the format becomes importable.
 *
 * Usage:
 *   const md = defineImporter({
 *     id: "markdown",
 *     name: "Markdown",
 *     description: "Import a Markdown transcript.",
 *     format: "markdown",
 *     extensions: ["md", "markdown"],
 *     mimeType: "text/markdown",
 *     import: async (src) => ({ success: true, data: String(src.content) }),
 *   })
 */

import type { CustomImporter } from "@/types/plugin/plugin"

export function defineImporter<T = unknown>(importer: CustomImporter<T>): CustomImporter<T> {
  return importer
}
