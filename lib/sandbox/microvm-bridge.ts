/**
 * ADR-0028 / T4 — sandboxTier routing bridge.
 *
 * One registered microVM adapter. The `cognia-e2b-sandbox`
 *      plugin calls `setMicrovmExec(impl)` on activate (it owns the
 *      `@e2b/sdk` import) and `setMicrovmExec(null)` on deactivate. When
 *      no implementation is registered AND a session asks for the
 *      microvm tier, the sandboxed-tools plugin treats it as strict-mode
 *      failure — there is no silent fallback to OS tier (matches ADR
 *      §Strict mode).
 */

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

export type MicrovmAdapterErrorCode =
  "workspace-unavailable" | "runtime-unbound" | "policy-not-attested" | "workspace-boundary"

export class MicrovmAdapterError extends Error {
  readonly code: MicrovmAdapterErrorCode

  constructor(code: MicrovmAdapterErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "MicrovmAdapterError"
    this.code = code
  }
}

export interface MicrovmExecAdapter {
  preflight?(ownerRef: string, workspaceRoot?: string, ownerGroup?: string): Promise<void> | void
  execute(ownerRef: string, payload: MicrovmExecPayload): Promise<MicrovmResult>
  release?(ownerRef: string): Promise<void> | void
  dispose?(): Promise<void> | void
}

let registeredImpl: MicrovmExecAdapter | null = null

/** Register the microvm exec adapter (called by the e2b plugin on activate). */
export function setMicrovmExec(impl: MicrovmExecAdapter | null): void {
  registeredImpl = impl
}

/** Read the currently-registered microvm exec adapter, or null. */
export function getMicrovmExec(): MicrovmExecAdapter | null {
  return registeredImpl
}

/** Test-only — wipe the adapter registry. Never called in production. */
export function __resetMicrovmBridgeForTesting(): void {
  registeredImpl = null
}
