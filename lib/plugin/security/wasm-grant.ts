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
import {
  clearWasmGrantRecords,
  listWasmGrantRecords,
  replaceWasmGrantRecords,
} from "@/lib/db/wasm-grant-ledger"
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
export const WASM_GRANT_DRIFT_WARNING =
  "WASM preopen grants differ from the active plugin manifest; denied drifted paths until the user reviews permissions."

interface PreopenLedger {
  [pluginId: string]: string[]
}

export interface WasmGrantReconciliation {
  allowedPreopens: string[]
  deniedLedgerPreopens: string[]
  ungrantedManifestPreopens: string[]
  warning?: string
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
export async function applyWasmCapabilityGrant(
  decision: WasmCapabilityGrantDecision,
  options: ApplyWasmGrantOptions = {}
): Promise<{ permissions: PluginPermission[]; preopens: string[] }> {
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

  const sortedPreopens = Array.from(new Set(decision.grantedPreopens)).sort()
  await replaceWasmGrantRecords(decision.pluginId, sortedPreopens, grantedBy)

  const ledger = readPreopenLedger()
  if (decision.grantedPreopens.length > 0) {
    ledger[decision.pluginId] = sortedPreopens
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
export async function getGrantedPreopens(pluginId: string): Promise<string[]> {
  const records = await listWasmGrantRecords(pluginId)
  if (records.length > 0) {
    return records.map((record) => record.preopen).sort()
  }

  const ledger = readPreopenLedger()
  const mirrored = Array.from(new Set(ledger[pluginId] ?? [])).sort()
  if (mirrored.length > 0) {
    await replaceWasmGrantRecords(pluginId, mirrored, "localStorage")
  }
  return mirrored
}

/**
 * Wipe every grant and preopen for a plugin. Called by the manager during
 * uninstall + by the per-plugin "revoke all" UI.
 */
export async function clearWasmCapabilityGrant(pluginId: string): Promise<void> {
  const guard = getPermissionGuard()
  guard.revokeAll(pluginId)
  await clearWasmGrantRecords(pluginId)
  const ledger = readPreopenLedger()
  if (pluginId in ledger) {
    delete ledger[pluginId]
    writePreopenLedger(ledger)
  }
}

export async function reconcileWasmGrantLedgerWithManifest(
  pluginId: string,
  manifestPreopens: readonly string[]
): Promise<WasmGrantReconciliation> {
  const granted = await getGrantedPreopens(pluginId)
  const manifest = Array.from(
    new Set(manifestPreopens.map((path) => path.trim()).filter(Boolean))
  ).sort()
  const grantedSet = new Set(granted)
  const manifestSet = new Set(manifest)
  const allowedPreopens = granted.filter((path) => manifestSet.has(path))
  const deniedLedgerPreopens = granted.filter((path) => !manifestSet.has(path))
  const ungrantedManifestPreopens = manifest.filter((path) => !grantedSet.has(path))
  const drifted = deniedLedgerPreopens.length > 0 || ungrantedManifestPreopens.length > 0
  if (drifted) {
    wasmGrantLogger.warn(WASM_GRANT_DRIFT_WARNING, {
      pluginId,
      deniedLedgerCount: deniedLedgerPreopens.length,
      ungrantedManifestCount: ungrantedManifestPreopens.length,
    })
  }
  return {
    allowedPreopens,
    deniedLedgerPreopens,
    ungrantedManifestPreopens,
    warning: drifted ? WASM_GRANT_DRIFT_WARNING : undefined,
  }
}
