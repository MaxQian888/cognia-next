/**
 * The Lucide catalog's two name spaces, without the SVG data.
 *
 * Manifest validation admits an icon name when the catalog can draw it; the
 * renderer (`lib/icons/lucide-catalog.tsx`) reads the full generated catalog.
 * Both JSON files come from one `pnpm lucide:generate` run, so a name admitted
 * here is a name the host can draw.
 */

import { toLucideIconName } from "./lucide-icon-name"
import names from "./lucide-icon-names.generated.json"

const generated = names as { iconNames: string[]; exportNames: Record<string, string> }
const iconNames = new Set(generated.iconNames)

export function hasLucideIcon(name: string): boolean {
  return iconNames.has(name)
}

export function getLucideIconNames(): readonly string[] {
  return generated.iconNames
}

export function getLucideExportNames(): readonly string[] {
  return Object.keys(generated.exportNames)
}

export function hasLucideExport(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(generated.exportNames, name)
}

/** The catalog name a package export resolves to, or `undefined`. */
export function lucideExportCatalogName(name: string): string | undefined {
  return hasLucideExport(name) ? generated.exportNames[name] : undefined
}

/**
 * The catalog entry a caller-written name refers to, or null.
 *
 * There are two name spaces, and a name can be valid in either. `iconNames`
 * holds lucide's canonical icons; `exportNames` holds what the package
 * exports, which is where its own renames survive as aliases — the `history`
 * icon is exported as `History` and `HistoryIcon` but keyed `RotateCcwClock`
 * in the record, so a caller naming `History` is naming a real icon that a
 * `hasLucideIcon` check alone answers "no" to.
 *
 * The kebab-case form is tried after both, because it is the spelling the
 * retired `PLUGIN_CONTEXT_PANEL_ICONS` allowlist published: an installed
 * plugin pinned to `"file-text"` — or `"history"` — is following the
 * documentation it was written against. Exact matches win, so no already-valid
 * name changes meaning.
 */
export function toCatalogIconName(name: string): string | null {
  if (hasLucideIcon(name)) return name
  const exported = lucideExportCatalogName(name)
  if (exported) return exported
  const pascal = toLucideIconName(name)
  if (pascal === name) return null
  if (hasLucideIcon(pascal)) return pascal
  return lucideExportCatalogName(pascal) ?? null
}
