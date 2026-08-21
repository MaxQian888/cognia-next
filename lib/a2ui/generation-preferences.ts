/**
 * A2UI generation preferences — the per-user "what should the hub composer
 * generate as" choice (acting character + provider/model override).
 *
 * Deliberately NOT an `AppSettings` field: those carry a `settings-sync`
 * category contract and are shared with chat, and this choice must do neither.
 * It only pre-fills the hub composer; an unset field falls through to the same
 * app defaults `resolveSendOptions` would have used anyway, so clearing a
 * preference is exactly equivalent to never having set one.
 *
 * Stored in localStorage next to `a2ui-app-instances` (see
 * `hooks/a2ui/app-builder/persistence.ts`) with the same shape of guard: a
 * corrupt or absent blob reads as "no preference" rather than throwing, because
 * a preference is never worth breaking the page over.
 */

import { loggers } from "@cognia/logging"

const log = loggers.a2ui

const STORAGE_KEY = "a2ui-generation-preferences"

export interface A2UIGenerationPreferences {
  /**
   * Character the generation turn runs as. Resolved by `resolveSendOptions`
   * exactly like a chat session's `characterId`, so it brings the character's
   * system prompt, skills and execution policy with it.
   */
  characterId?: string
  /** Model id override. Falls through to `appSettings.defaultModel` when unset. */
  model?: string
  /** Provider id override. Falls through to `appSettings.defaultProvider`. */
  provider?: string
}

const EMPTY: A2UIGenerationPreferences = {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Keep only the known string fields; a non-string is treated as absent. */
export function normalizeGenerationPreferences(input: unknown): A2UIGenerationPreferences {
  if (!isRecord(input)) return EMPTY
  const next: A2UIGenerationPreferences = {}
  for (const key of ["characterId", "model", "provider"] as const) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) next[key] = value
  }
  return next
}

export function loadGenerationPreferences(): A2UIGenerationPreferences {
  if (typeof window === "undefined") return EMPTY
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return EMPTY
    return normalizeGenerationPreferences(JSON.parse(raw))
  } catch (error) {
    log?.warn("A2UI: failed to read generation preferences", { error: String(error) })
    return EMPTY
  }
}

export function saveGenerationPreferences(next: A2UIGenerationPreferences): void {
  if (typeof window === "undefined") return
  const normalized = normalizeGenerationPreferences(next)
  try {
    if (Object.keys(normalized).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY)
      return
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized))
  } catch (error) {
    // A full/blocked quota must not stop the user from generating.
    log?.warn("A2UI: failed to persist generation preferences", { error: String(error) })
  }
}
