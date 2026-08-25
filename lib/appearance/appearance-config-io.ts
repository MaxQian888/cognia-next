// Whole-appearance config export / import. Serialises the appearance-owned
// AppSettings keys into a versioned, shareable JSON document and parses one
// back into a settings patch. This is the "share your whole look" companion to
// the single-theme `theme-export.ts`: a file produced here bundles the theme,
// color preset, custom themes, typography, density, radius, motion, a11y,
// component styles, custom CSS, auto-mode, and editor linking together.
//
// Deliberately excluded: `wallpapers` (device-local binary blobs that can't be
// resolved on another device) and `background` (points at a wallpaper id that
// won't exist elsewhere). Everything else is portable.
//
// The settings-sync table disagreed with that judgement for a long time and
// classified `wallpapers` as `shared`, so a paired phone and desktop mirrored
// libraries neither could open. It is `device-local` there too now, and
// `packages/agent-config-types/src/settings-sync.test.ts` pins the agreement.

import type { AppSettings } from "@cognia/agent-config-types"

const SCHEMA_URL = "https://cognia.dev/schemas/appearance-config/v1.json"
const FORMAT_VERSION = "v1"

/**
 * AppSettings keys captured by an appearance-config export. Mirrors the
 * appearance-owned keys in `lib/settings/section-keys.ts`, minus the two
 * device-local ones (`wallpapers`, `background`).
 */
export const APPEARANCE_CONFIG_KEYS = [
  "theme",
  "colorTheme",
  "customThemes",
  "activeCustomThemeId",
  "importedVscodeThemes",
  "fontScale",
  "language",
  "typographyExt",
  "density",
  "radius",
  "motion",
  "reduceMotion",
  "a11y",
  "componentStyles",
  "cursor",
  "customCss",
  "customCssEnabled",
  "customCssScope",
  "autoMode",
  "monacoLink",
  "activeThemePackId",
  // ADR-0114 / ADR-0127: `messageDisplay` supersedes `agentFlowMode`; both are
  // exported so an old config still round-trips its legacy value while a new
  // one carries the live preference (previously only the deprecated field
  // travelled and the live one was silently dropped).
  "messageDisplay",
  "agentFlowMode",
  "usageDisplayMode",
] as const satisfies readonly (keyof AppSettings)[]

export type AppearanceConfigKey = (typeof APPEARANCE_CONFIG_KEYS)[number]

export type AppearanceConfigPatch = Partial<Pick<AppSettings, AppearanceConfigKey>>

export interface AppearanceConfigFileV1 {
  $schema: typeof SCHEMA_URL
  formatVersion: typeof FORMAT_VERSION
  /** ISO 8601 timestamp of the export. */
  exportedAt: string
  settings: AppearanceConfigPatch
}

const ALLOWED_KEYS = new Set<string>(APPEARANCE_CONFIG_KEYS)

/**
 * Serialise the appearance slice of `settings` to a stable, versioned JSON
 * document. Only keys that are actually present (not `undefined`) are emitted,
 * so a fresh install exports a compact file rather than a wall of defaults.
 */
export function exportAppearanceConfig(settings: Partial<AppSettings>): string {
  const picked: AppearanceConfigPatch = {}
  for (const key of APPEARANCE_CONFIG_KEYS) {
    if (settings[key] !== undefined) {
      picked[key] = settings[key] as never
    }
  }
  const payload: AppearanceConfigFileV1 = {
    $schema: SCHEMA_URL,
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: picked,
  }
  return JSON.stringify(payload, null, 2)
}

/**
 * Parse a previously-exported appearance config back into a settings patch the
 * caller can hand to `save()`. Unknown keys are dropped (forward-compat with a
 * newer exporter), so the result only ever contains recognised appearance keys.
 *
 * Throws on invalid JSON, a non-object payload, an unsupported format version,
 * or a missing `settings` object.
 */
export function importAppearanceConfig(text: string): AppearanceConfigPatch {
  let obj: unknown
  try {
    obj = JSON.parse(text)
  } catch (err) {
    throw new Error(`Appearance config is not valid JSON: ${(err as Error).message}`)
  }
  if (typeof obj !== "object" || obj === null) {
    throw new Error("Appearance config must be an object")
  }
  const o = obj as Partial<AppearanceConfigFileV1>
  if (o.formatVersion !== FORMAT_VERSION) {
    throw new Error(`Unsupported appearance config version: ${String(o.formatVersion)}`)
  }
  if (typeof o.settings !== "object" || o.settings === null) {
    throw new Error("Appearance config is missing its settings object")
  }
  const src = o.settings as Record<string, unknown>
  const out: AppearanceConfigPatch = {}
  for (const [key, value] of Object.entries(src)) {
    if (ALLOWED_KEYS.has(key) && value !== undefined) {
      out[key as AppearanceConfigKey] = value as never
    }
  }
  return out
}

/** Count of recognised keys an imported patch will write. Drives the confirm copy. */
export function countConfigKeys(patch: AppearanceConfigPatch): number {
  return Object.keys(patch).length
}
