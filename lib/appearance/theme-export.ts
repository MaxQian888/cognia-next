import { pickKnownTokens } from "./theme-token-catalog"
import type { CustomTheme } from "@/types/plugin/plugin"

const SCHEMA_URL = "https://cognia.dev/schemas/custom-theme/v1.json"
const FORMAT_VERSION = "v1"

interface ThemeJsonV1 {
  $schema: typeof SCHEMA_URL
  formatVersion: typeof FORMAT_VERSION
  name: string
  baseVariant: "light" | "dark"
  derivedVariant?: "light" | "dark"
  tokens: { light: Record<string, string>; dark: Record<string, string> }
  /**
   * Extra custom properties a CSS-var plugin theme contributed that no token
   * covers. Dropped on the floor before — so exporting a plugin-derived theme
   * and importing it back produced a visibly different theme.
   */
  cssVars?: Record<string, string>
  /** Where the theme came from. Metadata only; badging, not behaviour. */
  sourcePluginId?: string
  sourceBuiltinName?: string
  exportedAt: string // ISO 8601
}

/**
 * Serialise a CustomTheme to a stable, versioned JSON document.
 *
 * - Always emits the dual-variant `tokens.{light, dark}` shape — if the
 *   passed-in theme only has the legacy `colors`/`isDark` pair, this
 *   throws (callers should run the v16 migration first).
 * - Strips internal `id` (importers assign a fresh one).
 * - Output is pretty-printed for human inspection / diff-friendly storage.
 */
export function exportThemeToJson(theme: CustomTheme): string {
  if (!theme.tokens || !theme.tokens.light || !theme.tokens.dark) {
    throw new Error("Theme has no dual-variant tokens. Run the v16 migration before exporting.")
  }
  const baseVariant: "light" | "dark" = theme.baseVariant ?? (theme.isDark ? "dark" : "light")
  const payload: ThemeJsonV1 = {
    $schema: SCHEMA_URL,
    formatVersion: FORMAT_VERSION,
    name: theme.name,
    baseVariant,
    ...(theme.derivedVariant ? { derivedVariant: theme.derivedVariant } : {}),
    tokens: {
      light: theme.tokens.light as unknown as Record<string, string>,
      dark: theme.tokens.dark as unknown as Record<string, string>,
    },
    ...(theme.cssVars && Object.keys(theme.cssVars).length > 0 ? { cssVars: theme.cssVars } : {}),
    ...(theme.sourcePluginId ? { sourcePluginId: theme.sourcePluginId } : {}),
    ...(theme.sourceBuiltinName ? { sourceBuiltinName: theme.sourceBuiltinName } : {}),
    exportedAt: new Date().toISOString(),
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Parse a previously-exported theme JSON back into a partial CustomTheme
 * (no id — caller assigns one via `createCustomTheme`).
 *
 * Token maps are filtered through the catalog. The file is user-supplied and
 * these values end up in `style.setProperty` calls, so an unrecognised key is
 * dropped rather than carried. A file written against the original 27-token
 * format imports unchanged: the missing 29 resolve at read time.
 *
 * Throws on:
 * - Non-object input.
 * - Missing or malformed `tokens.{light, dark}`.
 * - Missing `baseVariant` (we don't infer from token contents because that
 *   would silently accept malformed exports).
 */
export function importThemeFromJson(text: string): Omit<CustomTheme, "id"> {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (err) {
    throw new Error(`Theme JSON is invalid: ${(err as Error).message}`)
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Theme JSON must be an object")
  }
  const o = obj as Partial<ThemeJsonV1>
  if (!o.tokens || typeof o.tokens !== "object") {
    throw new Error("Theme JSON missing tokens")
  }
  if (!o.tokens.light || !o.tokens.dark) {
    throw new Error("Theme JSON missing tokens.light or tokens.dark")
  }
  if (o.baseVariant !== "light" && o.baseVariant !== "dark") {
    throw new Error("Theme JSON missing or invalid baseVariant")
  }
  const baseVariant = o.baseVariant
  return {
    name: typeof o.name === "string" && o.name.length > 0 ? o.name : "Imported Theme",
    baseVariant,
    ...(o.derivedVariant === "light" || o.derivedVariant === "dark"
      ? { derivedVariant: o.derivedVariant }
      : {}),
    tokens: {
      light: pickKnownTokens(o.tokens.light as Record<string, unknown>),
      dark: pickKnownTokens(o.tokens.dark as Record<string, unknown>),
    } as never,
    // Legacy mirror, same contract the editor writes.
    colors: pickKnownTokens(o.tokens[baseVariant] as Record<string, unknown>),
    isDark: baseVariant === "dark",
    ...(isCssVarMap(o.cssVars) ? { cssVars: o.cssVars } : {}),
    ...(typeof o.sourcePluginId === "string" ? { sourcePluginId: o.sourcePluginId } : {}),
    ...(typeof o.sourceBuiltinName === "string" ? { sourceBuiltinName: o.sourceBuiltinName } : {}),
  }
}

/**
 * A `--name: value` map of strings and nothing else. Names must look like
 * custom properties for the same reason token keys are filtered: whatever
 * survives here is written straight onto `document.documentElement`.
 */
function isCssVarMap(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return false
  return entries.every(
    ([name, v]) => /^--[a-zA-Z][\w-]*$/.test(name) && typeof v === "string" && v.length > 0
  )
}
