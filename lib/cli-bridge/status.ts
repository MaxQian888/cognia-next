/**
 * Renderer-side wrapper around the `cli_bridge_status` Tauri command.
 *
 * The CLI bridge is a loopback-only HTTP listener that `cognia-cli` uses to
 * drive a running desktop instance (install / uninstall / reload plugins).
 * The discovery file `cli-endpoint.json` is rewritten on every launch with a
 * fresh dev token; this getter lets the renderer (typically the Plugin
 * DevTools panel) confirm the bridge is up before nudging the user toward
 * the CLI flow.
 *
 * Web mode + Capacitor builds never spawn the bridge — `status()` reports
 * `running: false` with `boundPort: null` and `endpointFile: null` so the UI
 * doesn't crash, and the caller can render a "not available in this build"
 * hint.
 *
 * The Rust side lives at `src-tauri/src/cli_bridge/mod.rs:cli_bridge_status`.
 */

import { invoke } from "@tauri-apps/api/core"

import { loggers } from "@/lib/logging"
import { isTauri } from "@/lib/tauri"

const log = loggers.tray // shared "desktop tooling" channel — no dedicated cli-bridge logger yet

export interface CliBridgeStatus {
  running: boolean
  /** Loopback TCP port the axum listener bound to, or `null` when the
   * bridge never started. */
  boundPort: number | null
  /** Absolute path of the `cli-endpoint.json` discovery file, or `null` when
   * the OS config dir was unresolvable. */
  endpointFile: string | null
}

/** Snapshot returned to callers when the IPC layer is unavailable. */
const NOT_AVAILABLE: CliBridgeStatus = {
  running: false,
  boundPort: null,
  endpointFile: null,
}

/**
 * Fetch the current CLI bridge state. Returns {@link NOT_AVAILABLE} when
 * called outside Tauri or when the IPC call fails — callers should treat
 * `running === false` as "do not show CLI tooling".
 */
export async function getCliBridgeStatus(): Promise<CliBridgeStatus> {
  if (!isTauri()) return NOT_AVAILABLE
  try {
    const raw = await invoke<{
      running: boolean
      boundPort: number | null
      endpointFile: string | null
    }>("cli_bridge_status")
    return {
      running: Boolean(raw?.running),
      boundPort: typeof raw?.boundPort === "number" ? raw.boundPort : null,
      endpointFile: typeof raw?.endpointFile === "string" ? raw.endpointFile : null,
    }
  } catch (err) {
    log.warn("cli_bridge_status failed", { error: String(err) })
    return NOT_AVAILABLE
  }
}
