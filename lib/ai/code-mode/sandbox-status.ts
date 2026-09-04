/**
 * The renderer's answer to "is a strict sandbox actually enforced here?"
 * (ADR-0117, Phase 4).
 *
 * Backed by the existing ADR-0028 sandbox backend rather than anything new:
 * `sandbox_health_check` is the *active* confinement probe — it spawns real
 * confined commands and reports whether confinement was enforced. That is the
 * question Code mode has to answer, and it is deliberately not
 * `sandbox_health_probe`, which only checks that the backend binary exists. A
 * present-but-broken backend reports `available: true` on the cheap probe and
 * `confined: false` on this one, and offering Code on the strength of the
 * former would be exactly the false claim the ADR forbids.
 *
 * The active probe spawns processes, so the result is cached for the app
 * session. `refreshCodeSandboxStatus()` re-runs it on demand.
 */

import { transport } from "@/lib/tauri"
import { getOsSandboxExec } from "@/lib/sandbox/os-exec-bridge"
import { updateOsSandboxAvailability } from "@/lib/sandbox/runtime-availability"

export interface CodeSandboxStatus {
  /** True only when confinement was exercised and observed to hold. */
  confined: boolean
  /** Backend id (`macos-sandbox-exec`, `linux-bwrap`, …). Empty when unknown. */
  backend: string
  /** Reason confinement is unavailable, for the disabled-state explanation. */
  detail: string
}

const UNCONFINED: CodeSandboxStatus = { confined: false, backend: "", detail: "" }

interface RawProbeReport {
  backend?: string
  confined?: boolean
  detail?: string
}

let cached: Promise<CodeSandboxStatus> | null = null

async function probe(): Promise<CodeSandboxStatus> {
  try {
    // A Node host registers its own executor because `sandbox_health_check` is
    // a Tauri `invoke` and its transport refuses the name. Asking the executor
    // that will actually run the commands is the only way its answer describes
    // the sandbox the session will get, rather than the desktop's.
    const hostExecutor = getOsSandboxExec()
    if (hostExecutor) {
      const status = await hostExecutor.probe()
      updateOsSandboxAvailability(status)
      return status
    }
    const raw = await transport.call<RawProbeReport>("sandbox_health_check")
    const status = {
      confined: raw?.confined === true,
      backend: raw?.backend ?? "",
      detail: raw?.detail ?? "",
    }
    updateOsSandboxAvailability(status)
    return status
  } catch (error) {
    // Web and mobile hosts have no such command. An IPC failure is not
    // "probably confined" — it is the fail-closed answer.
    const status = { ...UNCONFINED, detail: error instanceof Error ? error.message : String(error) }
    updateOsSandboxAvailability(status)
    return status
  }
}

/** Probe once per app session; subsequent calls reuse the in-flight promise. */
export function codeSandboxStatus(): Promise<CodeSandboxStatus> {
  cached ??= probe()
  return cached
}

/** Re-run the active probe, e.g. after the user installs the backend. */
export function refreshCodeSandboxStatus(): Promise<CodeSandboxStatus> {
  cached = probe()
  return cached
}

/** Test seam; also used by the settings surface to reset between hosts. */
export function __resetCodeSandboxStatus(): void {
  cached = null
}
