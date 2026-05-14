/**
 * Persist the user's WASM capability grant decision into the permission
 * guard. The grant sheet (`WasmCapabilityGrantSheet`) emits a
 * `WasmCapabilityGrantDecision`; this module is the headless writer that
 * applies it without needing React context.
 *
 * Lives outside React on purpose so the class-based `PluginManager` can
 * call it during programmatic install (e.g. from a CLI dev-reload), not
 * only from the install UI.
 */

import { loggers } from "../core/logger"
import { getPermissionGuard } from "./permission-guard"
import type { PluginPermission } from "@/types/plugin"

const wasmGrantLogger = loggers.manager.child
  ? loggers.manager.child("wasm-grant")
  : loggers.manager

export interface WasmCapabilityGrantDecision {
  pluginId: string
  grantedPermissions: PluginPermission[]
  grantedPreopens: string[]
}

export interface ApplyWasmGrantOptions {
  /**
   * Override the `grantedBy` field stamped on each permission grant.
   * Defaults to `"user"` — this helper is meant for the install-sheet
   * code path. `"system"` is appropriate when the host auto-restores
   * grants from a backup snapshot.
   */
  grantedBy?: "manifest" | "user" | "system"
}

const PREOPEN_STORAGE_KEY = "cognia:wasm-plugin:preopens"

interface PreopenLedger {
  [pluginId: string]: string[]
}

function readPreopenLedger(): PreopenLedger {
  if (typeof localStorage === "undefined") return {}
  try {
    const raw = localStorage.getItem(PREOPEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PreopenLedger
    if (parsed && typeof parsed === "object") return parsed
    return {}
  } catch (error) {
    wasmGrantLogger.warn("Failed to read WASM preopen ledger", {
      error: error instanceof Error ? error.message : String(error),
    })
    return {}
  }
}

function writePreopenLedger(ledger: PreopenLedger): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(PREOPEN_STORAGE_KEY, JSON.stringify(ledger))
  } catch (error) {
    wasmGrantLogger.warn("Failed to write WASM preopen ledger", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/**
 * Apply a grant decision: write each permission into the permission guard
 * and persist the extra filesystem preopens for the install flow. Returns
 * the snapshot the caller should hand to the Rust host's
 * `plugin_wasm_load` command so the WASI ctx is built with the right
 * preopens.
 */
export function applyWasmCapabilityGrant(
  decision: WasmCapabilityGrantDecision,
  options: ApplyWasmGrantOptions = {}
): { permissions: PluginPermission[]; preopens: string[] } {
  const guard = getPermissionGuard()
  const grantedBy = options.grantedBy ?? "user"
  // Snapshot existing grants so we can revoke anything the user removed
  // when re-running the sheet for an already-installed plugin.
  const existing = new Set(guard.getPluginPermissions(decision.pluginId))
  const granted = new Set(decision.grantedPermissions)

  for (const permission of granted) {
    guard.grant(decision.pluginId, permission, { grantedBy })
  }
  for (const stale of existing) {
    if (!granted.has(stale)) {
      guard.revoke(decision.pluginId, stale)
    }
  }

  const ledger = readPreopenLedger()
  if (decision.grantedPreopens.length > 0) {
    ledger[decision.pluginId] = [...decision.grantedPreopens].sort()
  } else {
    delete ledger[decision.pluginId]
  }
  writePreopenLedger(ledger)

  return {
    permissions: [...granted].sort() as PluginPermission[],
    preopens: ledger[decision.pluginId] ?? [],
  }
}

/**
 * Returns the persisted set of granted preopens for a plugin, used when
 * re-launching an already-installed WASM plugin so the host's WASI ctx
 * preopens are reapplied.
 */
export function getGrantedPreopens(pluginId: string): string[] {
  const ledger = readPreopenLedger()
  return ledger[pluginId] ?? []
}

/**
 * Wipe every grant and preopen for a plugin. Called by the manager during
 * uninstall + by the per-plugin "revoke all" UI.
 */
export function clearWasmCapabilityGrant(pluginId: string): void {
  const guard = getPermissionGuard()
  guard.revokeAll(pluginId)
  const ledger = readPreopenLedger()
  if (pluginId in ledger) {
    delete ledger[pluginId]
    writePreopenLedger(ledger)
  }
}
