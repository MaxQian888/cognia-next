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

import { stripJsonComments } from "@/lib/appearance/vscode-theme/parse-json"

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
}

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
    data = JSON.parse(stripJsonComments(input.jsonText)) as VsCodeIconThemeData
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
 * Look up the icon definition for a file. Walks the standard VS Code
 * priority order:
 *   fileNames (exact) → fileExtensions (suffix) → languageIds (when known) → default file
 *
 * Returns the `iconDefinitions` entry, or `undefined` when nothing matches.
 */
export function resolveFileIcon(
  themeId: string,
  filename: string,
  languageId?: string
): VsCodeIconDefinition | undefined {
  const theme = themes.get(themeId)
  if (!theme) return undefined
  const data = theme.data
  const defs = data.iconDefinitions ?? {}
  // 1. Exact filename match (case-sensitive — VS Code matches both ways, we pick exact).
  if (data.fileNames && data.fileNames[filename]) {
    return defs[data.fileNames[filename]]
  }
  // 2. Extension suffix match — longest match wins.
  if (data.fileExtensions) {
    const dotIdx = filename.indexOf(".")
    if (dotIdx >= 0) {
      // VS Code tries from the longest dotted suffix to the shortest.
      let suffix = filename.slice(dotIdx + 1)
      while (suffix.length > 0) {
        const key = data.fileExtensions[suffix]
        if (key && defs[key]) return defs[key]
        const next = suffix.indexOf(".")
        if (next < 0) break
        suffix = suffix.slice(next + 1)
      }
    }
  }
  // 3. Language id match.
  if (languageId && data.languageIds?.[languageId]) {
    return defs[data.languageIds[languageId]]
  }
  // 4. Default file icon.
  if (data.file) return defs[data.file]
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
