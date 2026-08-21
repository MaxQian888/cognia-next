"use client"

/**
 * Persisted reachability preference — the renderer half of
 * `src-tauri/src/companion_api/reachability_config.rs`.
 *
 * The companion listener and the mDNS broadcaster used to be per-session UI
 * state: switching them on in Settings did not survive a restart, and nothing
 * restored them at boot. From a paired phone that is indistinguishable from
 * broken auto-discovery — the desktop simply stops answering and stops
 * advertising after every quit.
 *
 * These wrappers record the user's intent so the Rust `setup` hook can
 * re-establish it. **Only surfaces that represent a user decision should call
 * {@link patchReachabilityPrefs}** — see the Rust module docs for why an
 * internal server start (e.g. the fleet monitor's loopback ingress) must not
 * write the file and silently downgrade a saved LAN binding.
 *
 * Desktop-only: these are local Tauri commands, not companion RPCs, so a
 * browser or paired phone reads the all-off default and writes nothing rather
 * than throwing `unknown_command`.
 */

import { isTauri } from "@/lib/platform/detect"
import { transport } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.sync

export interface ReachabilityPrefs {
  /** Start the companion HTTPS listener at boot. */
  serverEnabled: boolean
  /** Port to bind. */
  port: number
  /** `true` → `127.0.0.1` only; `false` → `0.0.0.0` (LAN-reachable). */
  bindLoopbackOnly: boolean
  /** Advertise `_cognia._tcp.local.` once the listener is up. */
  mdnsEnabled: boolean
}

/**
 * Mirrors `ReachabilityConfig::default()`. `bindLoopbackOnly` defaults to the
 * narrow binding on both sides: a lost or unreadable preference must never
 * widen network exposure.
 */
export const DEFAULT_REACHABILITY_PREFS: ReachabilityPrefs = {
  serverEnabled: false,
  port: 27890,
  bindLoopbackOnly: true,
  mdnsEnabled: false,
}

export async function loadReachabilityPrefs(): Promise<ReachabilityPrefs> {
  if (!isTauri()) return { ...DEFAULT_REACHABILITY_PREFS }
  try {
    const config = await transport.call<ReachabilityPrefs>("companion_reachability_get")
    return { ...DEFAULT_REACHABILITY_PREFS, ...config }
  } catch (err) {
    log.warn("reachability prefs read failed", { err })
    return { ...DEFAULT_REACHABILITY_PREFS }
  }
}

/**
 * Write the full preference. Resolves `false` when the write did not happen
 * (non-desktop, or the command failed) so a caller can tell "saved" from
 * "silently dropped" — this preference only matters at the *next* boot, so a
 * failure has no immediate symptom to notice.
 */
export async function saveReachabilityPrefs(prefs: ReachabilityPrefs): Promise<boolean> {
  if (!isTauri()) return false
  try {
    await transport.call<void>("companion_reachability_set", { config: prefs })
    return true
  } catch (err) {
    log.warn("reachability prefs write failed", { err })
    return false
  }
}

/**
 * Read-modify-write one or more fields.
 *
 * Read-modify-write rather than a partial write because the Rust side stores
 * one record: sending only the changed key would reset every other preference
 * to its default. Returns the merged value that was written (or would have
 * been, off-desktop).
 */
export async function patchReachabilityPrefs(
  patch: Partial<ReachabilityPrefs>
): Promise<ReachabilityPrefs> {
  const current = await loadReachabilityPrefs()
  const next = { ...current, ...patch }
  await saveReachabilityPrefs(next)
  return next
}
