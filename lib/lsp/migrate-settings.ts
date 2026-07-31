/**
 * One-time migration of the legacy LSP settings into the first-class
 * `AppSettings.lsp` slice.
 *
 * Before unification, user LSP servers lived at
 * `AppSettings.developer.userLspServers` and the unsigned-binary toggle at
 * `AppSettings.developer.unsignedLspAllowed`. Both are now under
 * `AppSettings.lsp`. This pure transform moves the legacy values across and
 * clears the old fields. It is idempotent: once the legacy fields are gone it
 * reports `changed: false`, so the app-start initializer
 * (`lib/lsp/migrate-settings-initializer.ts`) saves at most once.
 */

import type { AppSettings, DeveloperSettings } from "@cognia/agent-config-types"
import type { LspServerConfig, LspSettings } from "@/types/lsp/config"

export interface LspSettingsMigrationResult {
  /** True when legacy fields were found and moved (a save is needed). */
  changed: boolean
  /** The migrated `AppSettings.lsp` value (unchanged when `changed` is false). */
  lsp: LspSettings | undefined
  /** The `AppSettings.developer` value with legacy LSP fields stripped. */
  developer: DeveloperSettings | undefined
}

/**
 * Compute the migrated `lsp` + `developer` slices from current settings.
 * Existing `settings.lsp.servers` win over legacy entries on id collision —
 * a user who already curated the new field is authoritative.
 */
export function migrateLspSettings(
  settings: Pick<AppSettings, "lsp" | "developer"> | null | undefined
): LspSettingsMigrationResult {
  const developer = settings?.developer
  const legacyServers = developer?.userLspServers
  const legacyUnsigned = developer?.unsignedLspAllowed
  const hasLegacy =
    (Array.isArray(legacyServers) && legacyServers.length > 0) || legacyUnsigned !== undefined

  if (!hasLegacy) {
    return { changed: false, lsp: settings?.lsp, developer }
  }

  const existing = settings?.lsp
  const existingServers = existing?.servers ?? []
  const existingIds = new Set(existingServers.map((s) => s.id))
  const merged: LspServerConfig[] = [...existingServers]
  for (const s of legacyServers ?? []) {
    if (!s || !s.id || existingIds.has(s.id)) continue
    existingIds.add(s.id)
    merged.push(s)
  }

  const lsp: LspSettings = {
    servers: merged,
    enabled: existing?.enabled,
    unsignedAllowed: existing?.unsignedAllowed ?? legacyUnsigned,
  }

  // Strip the legacy fields, preserving any other developer knobs.
  const nextDeveloper: DeveloperSettings | undefined = developer
    ? { ...developer, userLspServers: undefined, unsignedLspAllowed: undefined }
    : undefined

  return { changed: true, lsp, developer: nextDeveloper }
}
