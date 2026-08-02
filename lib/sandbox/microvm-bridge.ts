/**
 * ADR-0028 / T4 — sandboxTier routing bridge.
 *
 * Two pieces of state, both keyed by session id:
 *
 *   1. **Active tier per session.** `lib/claude/build-options.ts:resolveSendOptions`
 *      writes the tier (`"os"` | `"microvm"`) into this module right before
 *      the send goes out. The `cognia-sandboxed-tools` plugin reads it
 *      inside its `execute()` to decide whether to route a `sandbox_*` call
 *      through the OS sandbox (`sandbox_exec` Tauri command) or the e2b
 *      Firecracker microVM (`getMicrovmExec()`).
 *
 *   2. **Registered microvm exec implementation.** The `cognia-e2b-sandbox`
 *      plugin calls `setMicrovmExec(impl)` on activate (it owns the
 *      `@e2b/sdk` import) and `setMicrovmExec(null)` on deactivate. When
 *      no implementation is registered AND a session asks for the
 *      microvm tier, the sandboxed-tools plugin treats it as strict-mode
 *      failure — there is no silent fallback to OS tier (matches ADR
 *      §Strict mode).
 */

import type { SandboxShellTier } from "@/types/sandbox"

/** One result row from a sandboxed exec call — shape mirrored from
 *  `src-tauri/src/sandbox/types.rs::SandboxResult`. */
export interface MicrovmResult {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
}

/** Single argv command shape (mirrors `cognia-sandboxed-tools`'s payload). */
export interface MicrovmCommand {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string | null
  timeout: number
}

/** Per-call policy (mirrors `sandbox::policy::PolicyRequest`). */
export interface MicrovmRequest {
  writable: string[]
  readable: string[]
  targetFiles: string[]
  maxCpuSeconds: number
  maxMemoryMb: number
  network: "off" | "on" | "allowlist"
  networkHosts: string[]
}

/** Full payload an exec impl receives. */
export interface MicrovmExecPayload {
  tool: string
  command: MicrovmCommand
  request: MicrovmRequest
}

export type MicrovmExec = (payload: MicrovmExecPayload) => Promise<MicrovmResult>

let registeredImpl: MicrovmExec | null = null

/** Register the microvm exec adapter (called by the e2b plugin on activate). */
export function setMicrovmExec(impl: MicrovmExec | null): void {
  registeredImpl = impl
}

/** Read the currently-registered microvm exec adapter, or null. */
export function getMicrovmExec(): MicrovmExec | null {
  return registeredImpl
}

/** Active tier per session id. Keyed by session id; default = `"os"`. */
const activeTier = new Map<string, SandboxShellTier>()

/**
 * Stamp the resolved tier for the next send on `sessionId`. Called by
 * `resolveSendOptions` after the sandbox precedence chain runs. Pass
 * `null`/undefined sessionId to no-op (e.g. one-shot completions).
 */
export function setActiveSandboxTier(
  sessionId: string | null | undefined,
  tier: SandboxShellTier
): void {
  if (!sessionId) return
  activeTier.set(sessionId, tier)
}

/** Read the active tier for `sessionId`. Defaults to `"os"`. */
export function getActiveSandboxTier(sessionId: string | null | undefined): SandboxShellTier {
  if (!sessionId) return "os"
  return activeTier.get(sessionId) ?? "os"
}

/**
 * Should the e2b microVM adapter claim this session's exec calls?
 *
 * Only the `"microvm"` tier — `"cua-desktop"` routes exec into the bound
 * sandbox connection instead, and must NOT be treated as microVM. Callers use
 * this rather than comparing the tier themselves, so adding a tier cannot
 * silently widen what e2b claims.
 */
export function isMicrovmTier(sessionId: string | null | undefined): boolean {
  return getActiveSandboxTier(sessionId) === "microvm"
}

/** Clear the active tier when a session ends. Optional — Map entries are
 *  cheap, but clearing prevents stale tiers leaking into a recycled id. */
export function clearActiveSandboxTier(sessionId: string): void {
  activeTier.delete(sessionId)
}

/** Test-only — wipe both registries. Never called in production. */
export function __resetMicrovmBridgeForTesting(): void {
  registeredImpl = null
  activeTier.clear()
}
