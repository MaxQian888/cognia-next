/**
 * The user's OCR configuration, read from the settings row.
 *
 * `AppSettings.ocrSettings` is one field of a much larger host settings object
 * that a plugin has no business seeing — `ctx.settings` is a plugin-scoped
 * key/value store precisely so a plugin cannot read the rest of it. This is
 * the narrow accessor for the one slice an OCR plugin genuinely needs (default
 * provider, per-platform overrides, cache TTL), published to authors as
 * `@cognia/plugin-sdk/api/ocr-provider`.
 *
 * The settings module is imported lazily so a caller that never asks does not
 * pull the Dexie settings graph into its module graph, and a failure to read
 * resolves to `undefined` — "the user has not configured OCR", which every
 * caller already falls back on `DEFAULT_OCR_SETTINGS` for.
 */

import type { UserOcrSettings } from "@/types/ocr"

export async function loadUserOcrSettings(): Promise<UserOcrSettings | undefined> {
  try {
    const { getSettings } = await import("@/lib/db/settings")
    return (await getSettings())?.ocrSettings
  } catch {
    return undefined
  }
}
