/**
 * Settings profile transfer — portable export / import / reset of the app's
 * configuration, distinct from the full-database backup in `lib/data`.
 *
 * Export produces a small JSON document a user can carry to another machine.
 * Secrets are stripped two ways: an explicit top-level denylist plus a
 * recursive key-name scrub (anything that looks like a token / key / password).
 * Import validates the envelope and returns a `Partial<AppSettings>` patch with
 * identity / instance fields and secrets dropped — it can only ever loosen,
 * never exfiltrate, credentials.
 *
 * Reset reuses the canonical `DEFAULTS` so "restore defaults" never drifts from
 * the real shape. A global reset deliberately KEEPS credentials (resetting
 * preferences shouldn't sign you out); per-section reset scopes to that
 * section's owned keys.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { DEFAULTS } from "@/lib/db/settings"

export const SETTINGS_PROFILE_SCHEMA = "cognia-settings" as const
export const SETTINGS_PROFILE_VERSION = 1 as const

/** Secret / account-bound top-level keys never written to an export. */
export const SECRET_KEYS = [
  "apiKey",
  "apiBaseUrl",
  "skillsShToken",
] as const satisfies readonly (keyof AppSettings)[]

/** Identity / instance keys that must never transfer between installs. */
export const NON_TRANSFERABLE_KEYS = [
  "id",
  "updatedAt",
  "installUuid",
] as const satisfies readonly (keyof AppSettings)[]

/** Nested object keys whose name marks them as a secret — scrubbed recursively. */
const SECRET_KEY_RE = /(token|apikey|secret|password|passphrase|privatekey|credential)/i

export interface SettingsProfile {
  schema: typeof SETTINGS_PROFILE_SCHEMA
  version: number
  exportedAt: string
  settings: Partial<AppSettings>
}

export type ImportResult =
  { ok: true; patch: Partial<AppSettings> } | { ok: false; errorKey: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSecretValue(value: unknown): boolean {
  // Secrets are strings (a token) or string arrays (e.g. `apiKeys`). Boolean
  // preference flags like `revealSecrets` / `rememberPassphrase` share the
  // secret-y name but are NOT secrets — keep them.
  if (typeof value === "string") return true
  return Array.isArray(value) && value.every((v) => typeof v === "string")
}

/**
 * Recursively drop any key whose normalized name matches the secret pattern AND
 * whose value actually looks like a secret (string / string[]).
 */
export function deepStripSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepStripSecrets)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      const normalized = k.replace(/[^a-z0-9]/gi, "")
      if (SECRET_KEY_RE.test(normalized) && isSecretValue(v)) continue
      out[k] = deepStripSecrets(v)
    }
    return out
  }
  return value
}

/** Keys excluded from any export: explicit secrets + identity/instance fields. */
function excludedExportKeys(): Set<string> {
  return new Set<string>([...SECRET_KEYS, ...NON_TRANSFERABLE_KEYS])
}

/**
 * Build the export document. `now` is injectable for deterministic tests; in
 * the browser the caller passes `new Date().toISOString()`.
 */
export function exportSettingsProfile(settings: AppSettings, now: string): SettingsProfile {
  const excluded = excludedExportKeys()
  const sanitized: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(settings)) {
    if (excluded.has(k)) continue
    sanitized[k] = deepStripSecrets(v)
  }
  return {
    schema: SETTINGS_PROFILE_SCHEMA,
    version: SETTINGS_PROFILE_VERSION,
    exportedAt: now,
    settings: sanitized as Partial<AppSettings>,
  }
}

/** Serialize a profile to a pretty JSON string for download. */
export function serializeSettingsProfile(profile: SettingsProfile): string {
  return JSON.stringify(profile, null, 2)
}

/**
 * Validate + sanitize an imported profile. Unknown top-level keys are dropped
 * (only keys present in DEFAULTS are accepted), and secrets / identity fields
 * are stripped even if a hand-edited file tries to smuggle them in.
 */
export function importSettingsProfile(raw: unknown): ImportResult {
  let parsed: unknown = raw
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { ok: false, errorKey: "invalidJson" }
    }
  }
  if (!isPlainObject(parsed)) return { ok: false, errorKey: "invalidPayload" }
  if (parsed.schema !== SETTINGS_PROFILE_SCHEMA) return { ok: false, errorKey: "wrongSchema" }
  if (typeof parsed.version !== "number" || !Number.isFinite(parsed.version)) {
    return { ok: false, errorKey: "missingVersion" }
  }
  if (parsed.version > SETTINGS_PROFILE_VERSION) {
    return { ok: false, errorKey: "versionTooNew" }
  }
  if (!isPlainObject(parsed.settings)) return { ok: false, errorKey: "missingSettings" }

  const excluded = excludedExportKeys()
  const allowed = new Set(Object.keys(DEFAULTS))
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(parsed.settings)) {
    if (excluded.has(k)) continue
    if (!allowed.has(k)) continue // drop unknown keys
    patch[k] = deepStripSecrets(v)
  }
  if (Object.keys(patch).length === 0) return { ok: false, errorKey: "emptyProfile" }
  return { ok: true, patch: patch as Partial<AppSettings> }
}

/**
 * Build a reset patch. With `keys`, returns just those keys at their default
 * value. Without `keys`, returns ALL preference keys at default — but KEEPS
 * secrets (apiKey etc.) and identity fields so a global reset doesn't sign the
 * user out or wipe credentials.
 */
export function buildResetPatch(keys?: (keyof AppSettings)[]): Partial<AppSettings> {
  if (keys && keys.length > 0) {
    const patch: Partial<AppSettings> = {}
    for (const k of keys) {
      ;(patch as Record<string, unknown>)[k] = DEFAULTS[k]
    }
    return patch
  }
  const excluded = excludedExportKeys()
  const patch: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (excluded.has(k)) continue
    patch[k] = v
  }
  return patch as Partial<AppSettings>
}
