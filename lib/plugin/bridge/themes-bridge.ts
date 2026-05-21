/**
 * Plugin Themes Bridge
 *
 * Resolves `manifest.themes` contributions on plugin enable and registers
 * each one with the in-memory `theme-registry`. On disable, removes every
 * theme owned by that plugin so the appearance UI updates immediately.
 *
 * Two contribution shapes are accepted:
 *   - inline `{ id, name, colors, isDark? }` — direct ThemeColors object.
 *   - `{ id, name, vscodeJsonPath }` — relative path to a VSCode color
 *     theme `.json` file packaged with the plugin. Parsed through the same
 *     `vscodeThemeToCustomTheme` pipeline the import dialog uses.
 *
 * Errors are collected, never thrown. A bad single contribution must not
 * block the rest of the plugin's contributions (parity with `connectors-bridge`
 * and `tools-bridge`). Path traversal is rejected at the bridge layer.
 */

import type {
  PluginManifest,
  PluginThemeContribution,
  PluginManifestThemeColors,
} from "@/types/plugin/plugin"
import type { ThemeColors } from "@/types/plugin/plugin-extended"
import {
  registerPluginTheme,
  unregisterThemesByPlugin,
  type PluginTheme,
} from "@/lib/theme/theme-registry"
import { registerThemePack, unregisterThemePacksByPlugin } from "@/lib/theme/theme-pack-registry"
import { readTextFile } from "@/lib/file/file-operations"
import {
  stripJsonComments,
  vscodeThemeToCustomTheme,
  type VscodeThemeJson,
} from "@/lib/appearance/vscode-theme/parse-json"
import { loggers } from "@/lib/plugin/core/logger"

export interface ThemesBridgeError {
  pluginId: string
  contributionId: string
  message: string
}

export interface ThemesBridgeRegisterResult {
  registered: number
  errors: ThemesBridgeError[]
}

/**
 * Reject `vscodeJsonPath` values that try to escape the plugin root.
 * Allowed: relative subpaths like `themes/dark.json` or `./dark.json`.
 * Blocked: `..` segments, leading `/`, leading `\`, drive letters.
 */
function isUnsafeRelativePath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return true
  // Drive letter (Windows) or POSIX absolute.
  if (/^([A-Za-z]:)?[\\/]/.test(path)) return true
  // Any `..` segment after splitting on either separator.
  const segments = path.split(/[\\/]+/)
  return segments.some((seg) => seg === "..")
}

function joinPluginPath(baseDir: string, relative: string): string {
  if (baseDir.endsWith("/") || baseDir.endsWith("\\")) {
    return baseDir + relative
  }
  // Use `/` — Tauri's plugin-fs accepts both separators on Windows.
  return `${baseDir}/${relative}`
}

/**
 * Convert a ThemeColors object to a flat CSS-variable map. The shape is
 * intentionally simple — Tailwind-style names with `-` separators are used
 * by `lib/themes/index.ts` already, but the appearance UI only needs the
 * structured `colors` payload to render swatches. The `variables` map is
 * filled for parity with built-in `PluginTheme` objects so other consumers
 * (e.g., legacy plugin theme APIs) keep working.
 */
function colorsToVariables(colors: ThemeColors): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value !== "string" || value.length === 0) continue
    // Camel → kebab.
    const cssName = `--${key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`
    out[cssName] = value
  }
  return out
}

/** Discriminator without depending on the `in` operator (which doesn't narrow union types). */
function isVscodePathContribution(
  c: PluginThemeContribution
): c is { id: string; name: string; vscodeJsonPath: string } {
  return typeof (c as { vscodeJsonPath?: unknown }).vscodeJsonPath === "string"
}

/** Discriminator for ADR-0026 §3 §D CSS-vars variant. */
function isCssVariablesContribution(
  c: PluginThemeContribution
): c is { id: string; name: string; isDark?: boolean; cssVariables: Record<string, string> } {
  return (
    !isVscodePathContribution(c) &&
    typeof (c as { cssVariables?: unknown }).cssVariables === "object" &&
    (c as { cssVariables?: unknown }).cssVariables !== null
  )
}

const CSS_VAR_NAME_PATTERN = /^--[a-z][a-z0-9-]*$/
const CSS_VAR_VALUE_MAX_LEN = 200

/**
 * Sanitize a plugin-supplied CSS variable map. Variable names must match
 * `^--[a-z][a-z0-9-]*$`; values must be strings under the length cap and
 * must not contain `</style>` (defense against injection). Invalid entries
 * are dropped silently with a warning — the bridge never throws on a
 * single bad pair.
 */
function sanitizeCssVariables(
  vars: Record<string, string>,
  pluginId: string
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawName, rawValue] of Object.entries(vars)) {
    if (!CSS_VAR_NAME_PATTERN.test(rawName)) {
      loggers.manager.warn(
        `[themes-bridge] plugin ${pluginId}: dropping CSS variable with invalid name "${rawName}"`
      )
      continue
    }
    if (typeof rawValue !== "string" || rawValue.length === 0) {
      loggers.manager.warn(
        `[themes-bridge] plugin ${pluginId}: dropping non-string value for "${rawName}"`
      )
      continue
    }
    if (rawValue.length > CSS_VAR_VALUE_MAX_LEN) {
      loggers.manager.warn(
        `[themes-bridge] plugin ${pluginId}: dropping value for "${rawName}" exceeding ${CSS_VAR_VALUE_MAX_LEN} chars`
      )
      continue
    }
    if (rawValue.includes("</style>")) {
      loggers.manager.warn(
        `[themes-bridge] plugin ${pluginId}: dropping value for "${rawName}" containing </style>`
      )
      continue
    }
    out[rawName] = rawValue
  }
  return out
}

export { sanitizeCssVariables as __sanitizeCssVariablesForTesting }

/**
 * Resolve a single contribution to a structured `ThemeColors` + `isDark` pair.
 * Throws on hard errors so the caller can collect them per-contribution.
 */
async function resolveContribution(
  contribution: PluginThemeContribution,
  baseDir: string,
  pluginId?: string
): Promise<{ colors: ThemeColors; isDark: boolean; cssVariables?: Record<string, string> }> {
  if (isCssVariablesContribution(contribution)) {
    // CSS-vars-only contributions don't carry a structured ThemeColors
    // payload — supply the minimum the appearance pipeline needs (so the
    // legacy fallback path stays well-defined) and pass the sanitized
    // variable map through for the runtime injection layer.
    const sanitized = sanitizeCssVariables(contribution.cssVariables, pluginId ?? "<unknown>")
    return {
      colors: {
        background: sanitized["--background"] ?? "#000",
        foreground: sanitized["--foreground"] ?? "#fff",
      } as unknown as ThemeColors,
      isDark: contribution.isDark === true,
      cssVariables: sanitized,
    }
  }
  if (isVscodePathContribution(contribution)) {
    if (isUnsafeRelativePath(contribution.vscodeJsonPath)) {
      throw new Error(
        `Unsafe vscodeJsonPath rejected: "${contribution.vscodeJsonPath}". Path must be relative and free of ".." segments.`
      )
    }
    const fullPath = joinPluginPath(baseDir, contribution.vscodeJsonPath)
    const text = await readTextFile(fullPath)
    const cleaned = stripJsonComments(text)
    let parsed: VscodeThemeJson
    try {
      parsed = JSON.parse(cleaned) as VscodeThemeJson
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Invalid JSON in ${contribution.vscodeJsonPath}: ${message}`)
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error(`Theme JSON did not yield an object: ${contribution.vscodeJsonPath}`)
    }
    const result = vscodeThemeToCustomTheme(parsed, { nameHint: contribution.name })
    return { colors: result.theme.colors, isDark: result.theme.isDark === true }
  }

  // Inline shape — validate that the bare-object `colors` field is non-empty
  // and at least carries `background` + `foreground`. We don't enforce the
  // full ThemeColors set here; the appearance pipeline derives missing keys.
  const inline = contribution as Extract<
    PluginThemeContribution,
    { colors: PluginManifestThemeColors }
  >
  if (!inline.colors || typeof inline.colors !== "object") {
    throw new Error("Inline contribution missing `colors` object")
  }
  const required: Array<keyof ThemeColors> = ["background", "foreground"]
  for (const key of required) {
    if (typeof inline.colors[key as string] !== "string") {
      throw new Error(`Inline contribution missing required color "${String(key)}"`)
    }
  }
  return {
    colors: inline.colors as unknown as ThemeColors,
    isDark: inline.isDark === true,
  }
}

export class PluginThemesBridge {
  /**
   * Resolve every entry in `manifest.themes` and register the resulting
   * `PluginTheme`s. Returns a count + collected per-contribution errors.
   */
  async registerPluginThemes(
    pluginId: string,
    pluginName: string,
    manifest: PluginManifest,
    baseDir: string
  ): Promise<ThemesBridgeRegisterResult> {
    const contributions = manifest.themes ?? []
    const errors: ThemesBridgeError[] = []
    let registered = 0

    for (const contribution of contributions) {
      const contributionId = (contribution as { id?: string }).id ?? "<unknown>"
      try {
        const { colors, isDark, cssVariables } = await resolveContribution(
          contribution,
          baseDir,
          pluginId
        )
        // CSS-vars contributions override the auto-derived variable map;
        // structured-color contributions keep deriving from `colors`.
        const variables = cssVariables ?? colorsToVariables(colors)
        const theme: PluginTheme = {
          id: `${pluginId}.${contributionId}`,
          name: contribution.name,
          variables,
          variant: isDark ? "dark" : "light",
          source: "plugin",
          pluginId,
          pluginName,
          colors,
          isDark,
        }
        registerPluginTheme(theme)
        registered += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push({ pluginId, contributionId, message })
        loggers.manager.warn(
          `[themes-bridge] plugin ${pluginId}: contribution "${contributionId}" failed — ${message}`
        )
      }
    }

    return { registered, errors }
  }

  /**
   * Remove every theme registered for `pluginId`. Returns the number of
   * removed entries. Idempotent.
   */
  unregisterPluginThemes(pluginId: string): number {
    return unregisterThemesByPlugin(pluginId)
  }

  /**
   * Register every entry under `manifest.themePacks` with the theme-pack
   * registry. Unlike `registerPluginThemes`, this is purely metadata — no
   * file IO, no settings writes. The bridge does not validate inter-pack
   * references (theme/font/wallpaper ids); that is the theme-pack-applier's
   * job at apply time, where it can surface a useful UI error.
   *
   * v47 (ADR-0029).
   */
  registerPluginThemePacks(
    pluginId: string,
    pluginName: string,
    manifest: PluginManifest
  ): { registered: number } {
    const packs = manifest.themePacks ?? []
    let registered = 0
    for (const pack of packs) {
      if (!pack || typeof pack !== "object" || typeof pack.id !== "string") {
        loggers.manager.warn(
          `[themes-bridge] plugin ${pluginId}: skipping theme pack without a string id`
        )
        continue
      }
      try {
        registerThemePack({ pluginId, pluginName, pack })
        registered += 1
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        loggers.manager.warn(
          `[themes-bridge] plugin ${pluginId}: theme pack "${pack.id}" failed — ${message}`
        )
      }
    }
    return { registered }
  }

  /**
   * Remove every theme pack registered for `pluginId`. Idempotent.
   * v47 (ADR-0029).
   */
  unregisterPluginThemePacks(pluginId: string): number {
    return unregisterThemePacksByPlugin(pluginId)
  }
}

let singleton: PluginThemesBridge | null = null

export function getPluginThemesBridge(): PluginThemesBridge {
  if (!singleton) singleton = new PluginThemesBridge()
  return singleton
}

/** Test-only: drop the singleton so each test gets a fresh instance. */
export function __resetThemesBridgeForTesting(): void {
  singleton = null
}
