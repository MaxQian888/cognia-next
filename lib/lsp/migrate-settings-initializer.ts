/**
 * App-start wiring for the one-time LSP settings migration
 * (`lib/lsp/migrate-settings.ts`). Runs once the settings singleton is
 * loaded, moving legacy `developer.userLspServers` /
 * `developer.unsignedLspAllowed` into `AppSettings.lsp`, then persisting via
 * the settings store. Idempotent across sessions — after the first run the
 * legacy fields are gone and the migration reports no change.
 */

import { useSettingsStore } from "@/stores/settings/settings-store"
import { migrateLspSettings } from "./migrate-settings"

interface MigrationDeps {
  /** Read the current settings store state — injected for tests. */
  getState?: () => {
    settings: Parameters<typeof migrateLspSettings>[0]
    save: (patch: Record<string, unknown>) => Promise<void>
  }
  /** Subscribe to store changes — injected for tests. */
  subscribe?: (cb: () => void) => () => void
}

/**
 * Migrate now if settings are loaded; otherwise subscribe and migrate on the
 * first load. Returns a disposer that cancels the pending subscription (a
 * no-op once the migration has run).
 */
export function initLspSettingsMigration(deps: MigrationDeps = {}): () => void {
  const getState = deps.getState ?? (() => useSettingsStore.getState())
  const subscribe = deps.subscribe ?? ((cb: () => void) => useSettingsStore.subscribe(() => cb()))

  let done = false
  const attempt = (): boolean => {
    if (done) return true
    const state = getState()
    if (!state.settings) return false
    const result = migrateLspSettings(state.settings)
    done = true
    if (result.changed) {
      void state.save({ lsp: result.lsp, developer: result.developer }).catch(() => {
        /* a failed save is retried next app start — migration stays idempotent */
      })
    }
    return true
  }

  if (attempt()) return () => {}

  const unsubscribe = subscribe(() => {
    if (attempt()) unsubscribe()
  })
  return unsubscribe
}
