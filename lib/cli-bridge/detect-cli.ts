/**
 * Renderer-side wrapper around the `detect_binary` Tauri command
 * (`src-tauri/src/cli_bridge/detect.rs`). Probes whether an external CLI
 * is present on the host and what version it reports.
 *
 * On web / Capacitor the bridge can't spawn a process, so we short-circuit
 * to `available: false, error: "web"` — callers gate the surrounding UI
 * with `isTauri()` the same way `lib/cli-bridge/status.ts` does.
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"
import { loggers } from "@cognia/logging"

const log = loggers.tray // shared "desktop tooling" channel

export interface BinaryDetectionResult {
  available: boolean
  version: string | null
  path: string | null
  error: string | null
}

const WEB_RESULT: BinaryDetectionResult = {
  available: false,
  version: null,
  path: null,
  error: "web",
}

/**
 * Probe a binary by name. `versionArg` defaults to `--version` on the
 * native side. Never throws — an unreachable IPC layer or a sandboxed
 * runtime resolves to `available: false`.
 */
export async function detectCli(name: string, versionArg?: string): Promise<BinaryDetectionResult> {
  if (!isTauri()) return WEB_RESULT
  try {
    const raw = await invoke<{
      available: boolean
      version?: string
      path?: string
      error?: string
    }>("detect_binary", { name, versionArg: versionArg ?? null })
    return {
      available: Boolean(raw?.available),
      version: typeof raw?.version === "string" ? raw.version : null,
      path: typeof raw?.path === "string" ? raw.path : null,
      error: typeof raw?.error === "string" ? raw.error : null,
    }
  } catch (err) {
    log.warn("detect_binary failed", { name, error: String(err) })
    return { available: false, version: null, path: null, error: String(err) }
  }
}

/**
 * Compare a detected version string against a minimum semver constraint.
 * Lenient: extracts the first `x.y.z` it finds in the version output
 * (CLIs print "cognia 0.1.0", "git version 2.43.0", etc.) and does a
 * numeric triple compare. Returns true when no constraint is given or
 * the parse fails (presence is enough — the gate is advisory, not a
 * hard semver lock).
 */
export function satisfiesMinVersion(detectedVersion: string | null, minVersion?: string): boolean {
  if (!minVersion) return true
  if (!detectedVersion) return false
  const got = extractSemver(detectedVersion)
  const want = extractSemver(minVersion)
  if (!got || !want) return true
  for (let i = 0; i < 3; i++) {
    if (got[i] > want[i]) return true
    if (got[i] < want[i]) return false
  }
  return true
}

function extractSemver(s: string): [number, number, number] | null {
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}
