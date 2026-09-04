/**
 * ADR-0028 / T1, the OS-tier execution seam for hosts without Tauri IPC.
 *
 * The desktop reaches the OS sandbox through `transport.call("sandbox_exec")`,
 * which resolves to a Tauri `invoke`. Nothing else can: the CLI's stdio
 * transport answers `unsupported command "sandbox_exec"`, and a companion
 * transport never carried the command because it is `target: client` in
 * `protocol/companion-commands.json`. So on those hosts the OS tier had no
 * implementation at all, while `sandbox/status` still reported a policy as
 * "enabled" and the session ceiling still clamped every request against it.
 *
 * This is the same registration shape `lib/sandbox/microvm-bridge` uses for the
 * e2b tier: a Node host registers an executor at bootstrap, and the tier router
 * prefers it over the Tauri transport. Registering nothing changes nothing, so
 * the desktop keeps its `invoke` path untouched.
 *
 * There is no silent fallback in either direction. A host that registers an
 * executor uses it. A host that registers none and has no Tauri IPC gets the
 * transport's own refusal, which is the fail-closed answer ADR-0028 requires.
 */

import type { CodeSandboxStatus } from "@/lib/ai/code-mode/sandbox-status"
import type { MicrovmExecPayload, MicrovmResult } from "@cognia/plugin-sdk/api/sandbox"

export interface OsSandboxExecutor {
  /**
   * Run one confined command. The payload is exactly what the Tauri
   * `sandbox_exec` command receives, so an executor is a transport swap and
   * never a second policy implementation.
   */
  execute(payload: MicrovmExecPayload): Promise<MicrovmResult>
  /**
   * The ACTIVE confinement probe, the same question `sandbox_health_check`
   * answers: were real confined commands run and observed to be confined?
   * Distinct from "the backend binary exists", which is not evidence.
   */
  probe(): Promise<CodeSandboxStatus>
  /** Release host resources at the application exit boundary. */
  dispose?(): Promise<void> | void
}

let registered: OsSandboxExecutor | null = null
const listeners = new Set<() => void>()

/**
 * Register the host's OS-tier executor, or `null` to withdraw it.
 *
 * Called once at bootstrap by a Node host. Withdrawing does not fall back to
 * anything: the tier router returns to the Tauri transport, which refuses off
 * the desktop.
 */
export function setOsSandboxExec(impl: OsSandboxExecutor | null): void {
  if (registered === impl) return
  registered = impl
  for (const listener of listeners) listener()
}

/** The currently-registered executor, or null when the host has none. */
export function getOsSandboxExec(): OsSandboxExecutor | null {
  return registered
}

export function subscribeOsSandboxAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Withdraw and dispose the executor at the application exit boundary. */
export async function disposeOsSandboxExec(): Promise<void> {
  const active = registered
  registered = null
  for (const listener of listeners) listener()
  if (active?.dispose) await active.dispose()
}

/** Test-only. Wipes the registry so suites do not leak an executor. */
export function __resetOsSandboxBridgeForTesting(): void {
  registered = null
  listeners.clear()
}
