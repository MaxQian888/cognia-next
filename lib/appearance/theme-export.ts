import type { CustomTheme } from "@/types/plugin/plugin-extended"

const SCHEMA_URL = "https://cognia.dev/schemas/custom-theme/v1.json"
const FORMAT_VERSION = "v1"

interface ThemeJsonV1 {
  $schema: typeof SCHEMA_URL
  formatVersion: typeof FORMAT_VERSION
  name: string
  baseVariant: "light" | "dark"
  derivedVariant?: "light" | "dark"
  tokens: { light: Record<string, string>; dark: Record<string, string> }
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
    exportedAt: new Date().toISOString(),
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Parse a previously-exported theme JSON back into a partial CustomTheme
 * (no id — caller assigns one via `createCustomTheme`).
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
  return {
    name: typeof o.name === "string" && o.name.length > 0 ? o.name : "Imported Theme",
    baseVariant: o.baseVariant,
    ...(o.derivedVariant === "light" || o.derivedVariant === "dark"
      ? { derivedVariant: o.derivedVariant }
      : {}),
    tokens: {
      light: o.tokens.light as Record<string, string>,
      dark: o.tokens.dark as Record<string, string>,
    } as never,
  }
}
