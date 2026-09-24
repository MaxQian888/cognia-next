/**
 * VS Code icon themes bridge.
 *
 * `contributes.iconThemes[]` declares icon themes — each is a JSON file
 * mapping file extensions / language ids / folder names to icon definitions.
 * cognia surfaces them in two places:
 *
 *   1. Cognia's existing icon system (`lib/icon/*`) — file/folder icons in
 *      the artifact preview, canvas tree, etc.
 *   2. Monaco's `setFileIconTheme` (NOT bundled yet — this bridge just
 *      registers the data; the renderer's appearance system reads it on
 *      next theme apply).
 *
 * Per-plugin tracking + idempotent unregister, mirrors themes-bridge.
 *
 * Icon themes have a richer schema than color themes:
 *   {
 *     "fonts":     [ { "id": "fontA", "src": [...], "weight": "normal" } ],
 *     "iconDefinitions": { "_javascript": { "fontCharacter": "\\F1", "fontColor": "..." } },
 *     "fileExtensions": { "js": "_javascript", "jsx": "_javascript" },
 *     "fileNames":   { "package.json": "_npm" },
 *     "languageIds": { "javascript": "_javascript" },
 *     "folderNames": { ".vscode": "_folder_vscode" },
 *     "folderNamesExpanded": { ... },
 *     "rootFolder": "_folder_root",
 *     "rootFolderExpanded": "_folder_root_open",
 *     "hidesExplorerArrows": false
 *   }
 *
 * We preserve the full schema verbatim under `theme.raw` so consumers can
 * walk it without re-parsing.
 */

import { parseJsonc } from "@/lib/jsonc"

export interface VsCodeIconDefinition {
  iconPath?: string
  fontCharacter?: string
  fontColor?: string
  fontSize?: string
  fontId?: string
}

export interface VsCodeIconFont {
  id: string
  src: Array<{ path: string; format?: string }>
  weight?: string
  style?: string
  size?: string
}

/**
 * The per-colour-scheme association overrides a theme may carry under
 * `light` / `highContrast`. Each map overrides the base map key by key; a key
 * the override does not mention keeps its base icon.
 */
export interface VsCodeIconThemeAssociations {
  file?: string
  folder?: string
  folderExpanded?: string
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  languageIds?: Record<string, string>
  rootFolder?: string
  rootFolderExpanded?: string
}

export interface VsCodeIconThemeData {
  fonts?: VsCodeIconFont[]
  iconDefinitions?: Record<string, VsCodeIconDefinition>
  file?: string
  folder?: string
  folderExpanded?: string
  folderNames?: Record<string, string>
  folderNamesExpanded?: Record<string, string>
  fileExtensions?: Record<string, string>
  fileNames?: Record<string, string>
  languageIds?: Record<string, string>
  rootFolder?: string
  rootFolderExpanded?: string
  hidesExplorerArrows?: boolean
  /** Associations VS Code applies instead of the base ones under a light theme. */
  light?: VsCodeIconThemeAssociations
  /** Associations VS Code applies instead of the base ones under high contrast. */
  highContrast?: VsCodeIconThemeAssociations
}

/** Which association set a lookup honours, as VS Code picks it per workbench theme. */
export type IconThemeColorScheme = "dark" | "light" | "highContrast"

export interface IconThemeContribution {
  /**
   * Plugin root the theme was read from (W5.1). Consumers join this with the
   * directory of `jsonPath` to resolve relative `iconPath` image references.
   * Absent for contributions registered directly with raw JSON (tests).
   */
  baseDir?: string
  /** Stable id = `${pluginId}.${themeId}`. */
  id: string
  /** Owning plugin id. */
  pluginId: string
  /** Display label. */
  name: string
  /** Path inside the plugin (forward-slash normalised). */
  jsonPath: string
  /** Parsed theme data. */
  data: VsCodeIconThemeData
}

const themes = new Map<string, IconThemeContribution>()
const listeners = new Set<(event: IconThemeEvent) => void>()

export type IconThemeEventType = "register" | "unregister"
export interface IconThemeEvent {
  type: IconThemeEventType
  contribution: IconThemeContribution
}

function emit(event: IconThemeEvent): void {
  queueMicrotask(() => {
    for (const fn of listeners) {
      try {
        fn(event)
      } catch (err) {
        console.warn("Icon theme listener threw:", err)
      }
    }
  })
}

/**
 * Register one icon theme from a parsed JSON source. Throws on malformed
 * input — caller is responsible for catching and converting to per-theme
 * warnings (themes-bridge does this for color themes; the renderer's
 * bootstrap will do the same here).
 */
export function registerIconTheme(input: {
  pluginId: string
  themeId: string
  name: string
  jsonPath: string
  jsonText: string
  baseDir?: string
}): IconThemeContribution {
  let data: VsCodeIconThemeData
  try {
    data = parseJsonc<VsCodeIconThemeData>(input.jsonText)
  } catch (err) {
    throw new Error(
      `Invalid JSON in icon theme "${input.themeId}" (${input.jsonPath}): ${(err as Error).message}`
    )
  }
  if (!data || typeof data !== "object") {
    throw new Error(`Icon theme "${input.themeId}" did not yield an object`)
  }
  const contribution: IconThemeContribution = {
    id: `${input.pluginId}.${input.themeId}`,
    pluginId: input.pluginId,
    name: input.name,
    jsonPath: input.jsonPath,
    data,
    ...(input.baseDir ? { baseDir: input.baseDir } : {}),
  }
  themes.set(contribution.id, contribution)
  emit({ type: "register", contribution })
  return contribution
}

export function unregisterIconTheme(id: string): void {
  const contribution = themes.get(id)
  if (!contribution) return
  themes.delete(id)
  emit({ type: "unregister", contribution })
}

export function unregisterIconThemesByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, contribution] of themes) {
    if (contribution.pluginId === pluginId) {
      themes.delete(id)
      emit({ type: "unregister", contribution })
      removed += 1
    }
  }
  return removed
}

export function listIconThemes(): IconThemeContribution[] {
  return [...themes.values()]
}

export function getIconTheme(id: string): IconThemeContribution | undefined {
  return themes.get(id)
}

/**
 * Theme key lookup the way VS Code resolves it: the exact spelling first, then
 * the lower-cased one. VS Code lower-cases the resource name before matching
 * (`getIconClasses`), and real themes key on lower case accordingly — Material
 * Icon Theme maps `readme.md`, `dockerfile`, `license`, never `README.md` — so
 * an exact-only lookup gives the most visible files in any tree a generic icon.
 */
function lookupThemeKey(map: Record<string, string>, key: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(map, key)) return map[key]
  const lower = key.toLowerCase()
  return lower !== key && Object.prototype.hasOwnProperty.call(map, lower) ? map[lower] : undefined
}

/**
 * One association map as VS Code sees it under `scheme`: the scheme's
 * override entry for a key wins, the base entry answers every key the
 * override does not mention (Material's light set re-colours 179 filenames,
 * it does not repeat the other thousand).
 */
function lookupAssociation(
  data: VsCodeIconThemeData,
  scheme: IconThemeColorScheme,
  map: "fileNames" | "fileExtensions",
  key: string
): string | undefined {
  const override = scheme === "dark" ? undefined : data[scheme]?.[map]
  const fromOverride = override ? lookupThemeKey(override, key) : undefined
  if (fromOverride) return fromOverride
  const base = data[map]
  return base ? lookupThemeKey(base, key) : undefined
}

/**
 * Look up the icon definition for a file. Walks the standard VS Code
 * priority order:
 *   fileNames → fileExtensions (longest suffix) → languageIds (when known) → default file
 * Name and extension keys match case-insensitively, exact spelling first. Under
 * a `light` / `highContrast` scheme each step consults that section's
 * overrides before the base associations, exactly as VS Code layers them.
 *
 * Returns the `iconDefinitions` entry, or `undefined` when nothing matches.
 */
export function resolveFileIcon(
  themeId: string,
  filename: string,
  languageId?: string,
  scheme: IconThemeColorScheme = "dark"
): VsCodeIconDefinition | undefined {
  const theme = themes.get(themeId)
  if (!theme) return undefined
  const data = theme.data
  const defs = data.iconDefinitions ?? {}
  const override = scheme === "dark" ? undefined : data[scheme]
  // 1. Filename match.
  const byName = lookupAssociation(data, scheme, "fileNames", filename)
  if (byName) {
    return defs[byName]
  }
  // 2. Extension suffix match — longest match wins.
  const dotIdx = filename.indexOf(".")
  if (dotIdx >= 0 && (data.fileExtensions || override?.fileExtensions)) {
    // VS Code tries from the longest dotted suffix to the shortest.
    let suffix = filename.slice(dotIdx + 1)
    while (suffix.length > 0) {
      const key = lookupAssociation(data, scheme, "fileExtensions", suffix)
      if (key && defs[key]) return defs[key]
      const next = suffix.indexOf(".")
      if (next < 0) break
      suffix = suffix.slice(next + 1)
    }
  }
  // 3. Language id match.
  if (languageId) {
    // Own-property reads, like the name/extension maps: a language id must
    // never resolve through `Object.prototype`.
    const byLanguage =
      (override?.languageIds ? lookupThemeKey(override.languageIds, languageId) : undefined) ??
      (data.languageIds ? lookupThemeKey(data.languageIds, languageId) : undefined)
    if (byLanguage) return defs[byLanguage]
  }
  // 4. Default file icon.
  const fallback = override?.file ?? data.file
  if (fallback) return defs[fallback]
  return undefined
}

/**
 * The icon theme consumers render from (W5.1). There is no user-facing
 * selector yet, so the FIRST registered contribution wins deterministically —
 * mirroring the first-wins conflict policy elsewhere in the plugin system.
 */
export function getActiveIconTheme(): IconThemeContribution | undefined {
  return themes.values().next().value
}

export function subscribeIconThemes(listener: (event: IconThemeEvent) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetIconThemesForTesting(): void {
  themes.clear()
  listeners.clear()
}

// ── W5.1: enable-time registration from manifest.vscodeIconThemes ────────────
import { isUnsafeRelativePath, readContainedPluginFile } from "./plugin-file-path"

export interface IconThemeManifestEntry {
  id: string
  label: string
  path: string
}

export async function registerIconThemesForPlugin(
  pluginId: string,
  entries: readonly IconThemeManifestEntry[],
  baseDir: string
): Promise<{ registered: number; errors: string[] }> {
  const errors: string[] = []
  let registered = 0
  for (const entry of entries) {
    try {
      if (!entry.id) throw new Error("missing icon theme id")
      if (isUnsafeRelativePath(entry.path)) {
        throw new Error(`unsafe icon theme path "${entry.path}"`)
      }
      const jsonText = await readContainedPluginFile(pluginId, baseDir, entry.path)
      registerIconTheme({
        pluginId,
        themeId: entry.id,
        name: entry.label || entry.id,
        jsonPath: entry.path,
        jsonText,
        baseDir,
      })
      registered += 1
    } catch (err) {
      errors.push(`${entry.id || entry.path}: ${(err as Error).message}`)
    }
  }
  return { registered, errors }
}
