/**
 * Wrangler binary discovery for Cognia Sites.
 *
 * Reuses the existing `detect_binary` Tauri command (through
 * {@link detectCli}) to resolve wrangler's absolute path on PATH or in an
 * app-managed directory, then auto-approves the exact bytes through the Sites
 * tool ledger ({@link approveSiteProviderTool}) so the fail-closed sandboxed
 * uploader accepts it — the user never pastes an absolute path.
 *
 * Desktop-only: `detectCli` short-circuits to `available: false` on web /
 * Capacitor, so both functions resolve to "not found" there without throwing.
 */
import { invoke } from "@tauri-apps/api/core"

import { detectCli, type BinaryDetectionResult } from "@/lib/cli-bridge/detect-cli"
import { isTauri } from "@/lib/tauri"
import { approveSiteProviderTool } from "@/lib/sites/approved-tool"

const WRANGLER_BINARY = "wrangler"

export interface WranglerDetection {
  /** Absolute path when wrangler resolved on this host, else null. */
  path: string | null
  /** Reported version string (e.g. "wrangler 3.90.0"), when available. */
  version: string | null
  /** True only when the binary is present AND its absolute path resolved. */
  ready: boolean
}

/** Pure projection of a raw detection result. Exposed for unit testing. */
export function toWranglerDetection(result: BinaryDetectionResult): WranglerDetection {
  const path = result.available && result.path ? result.path : null
  return { path, version: result.version, ready: path !== null }
}

/**
 * Probe wrangler on the host. Never throws — an unreachable IPC layer or a
 * web runtime resolves to `{ ready: false, path: null }`.
 */
export async function detectWranglerBinary(): Promise<WranglerDetection> {
  return toWranglerDetection(await detectCli(WRANGLER_BINARY))
}

/**
 * Detect wrangler and, when found, approve its exact bytes in the Sites tool
 * ledger so the sandboxed uploader accepts it. Returns the full detection so
 * callers can surface the version/path; `detection.path` is null when wrangler
 * is not resolvable on this host.
 *
 * Approval failures propagate: a changed or unreadable binary must surface as
 * an error, never silently pass the sandbox gate. `detect` is injectable for
 * tests.
 */
export async function ensureWranglerApproved(
  detect: () => Promise<WranglerDetection> = detectWranglerBinary
): Promise<WranglerDetection> {
  const detection = await detect()
  if (detection.path) await approveSiteProviderTool(detection.path)
  return detection
}

/**
 * Re-probe wrangler after the user installs it, busting the native 300s
 * detection cache first so a freshly-installed binary is found immediately.
 * Cache invalidation is best-effort — a stale-cache probe still resolves
 * correctly, just up to the TTL later.
 */
export async function redetectWranglerBinary(): Promise<WranglerDetection> {
  if (isTauri()) {
    try {
      await invoke("detect_binary_invalidate", { name: WRANGLER_BINARY })
    } catch {
      // Best-effort; fall through to a normal probe.
    }
  }
  return ensureWranglerApproved()
}
