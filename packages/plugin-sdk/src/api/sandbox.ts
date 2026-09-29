/** Portable sandbox contracts shared by providers, consumers, and the host. */

export interface MicrovmResult {
  exit_code: number
  stdout: string
  stderr: string
  duration: number
  timed_out: boolean
  /** True when stdout exceeded the per-stream transport cap. */
  stdout_truncated?: boolean
  /** True when stderr exceeded the per-stream transport cap. */
  stderr_truncated?: boolean
  /**
   * What the adapter ATTESTS it enforced for this call, as opposed to what the
   * request asked for. Omitted by an adapter that attests nothing; a consumer
   * that needs a guarantee (the Router + Fusion acceptance run needs
   * "no network") treats an absent or `networkEnforced: false` block as no
   * guarantee at all.
   */
  confinement?: MicrovmConfinement | null
}

/** A microVM adapter's attestation of the confinement one call ran under. */
export interface MicrovmConfinement {
  /** True only when the machine itself had no egress while the call ran. */
  networkEnforced: boolean
  backend?: string | null
  /** Null when the adapter does not enforce (or cannot attest) the ceiling. */
  maxMemoryMb?: number | null
  maxCpuSeconds?: number | null
  maxProcesses?: number | null
  platform?: string | null
}

/** Requirements a caller puts on a workspace before choosing the microVM tier. */
export interface MicrovmWorkspaceRequirements {
  /**
   * The ownership group the caller will pass to `preflight`. Defaults to the
   * owner ref, exactly as `preflight` does.
   */
  ownerGroup?: string
  /** The caller will ask for `network: "off"` and needs the machine to enforce it. */
  network?: "off" | "on"
}

/** Answer of {@link MicrovmExecAdapter.accepts}: never throws, always says why not. */
export type MicrovmWorkspaceAcceptance =
  { accepted: true } | { accepted: false; code: MicrovmAdapterErrorCode; reason: string }

/**
 * Answer of {@link MicrovmExecAdapter.readFile}. A file past the cap is refused
 * rather than cut, so a consumer never half-parses it.
 */
export type MicrovmFileRead =
  | { kind: "ok"; content: string }
  /** No such file: the ordinary "the command wrote nothing" answer. */
  | { kind: "missing" }
  | { kind: "too_large" }
  | { kind: "refused"; code: string; message?: string }

export interface MicrovmCommand {
  argv: string[]
  cwd: string
  env: Record<string, string>
  stdin: string | null
  timeout: number
}

export interface MicrovmRequest {
  writable: string[]
  readable: string[]
  targetFiles: string[]
  maxCpuSeconds: number
  maxMemoryMb: number
  network: "off" | "on" | "allowlist"
  networkHosts: string[]
}

export interface MicrovmCeiling {
  network?: "off" | "on" | "allowlist"
  maxCpuSeconds?: number
  maxMemoryMb?: number
}

export interface MicrovmExecPayload {
  tool: string
  command: MicrovmCommand
  request: MicrovmRequest
  ceiling?: MicrovmCeiling
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
  /**
   * Whether `preflight(ownerRef, workspaceRoot, requirements.ownerGroup)` would
   * succeed AND the bound machine can meet `requirements`, without claiming
   * anything. A caller choosing between tiers asks this first, so a workspace
   * the adapter cannot run in (an ordinary local directory, for an adapter that
   * only isolates into existing remote workspaces) makes the tier ineligible
   * instead of failing the run after it was chosen. An adapter without it
   * cannot be chosen by such a caller.
   */
  accepts?(
    ownerRef: string,
    workspaceRoot: string,
    requirements?: MicrovmWorkspaceRequirements
  ): Promise<MicrovmWorkspaceAcceptance> | MicrovmWorkspaceAcceptance
  execute(ownerRef: string, payload: MicrovmExecPayload): Promise<MicrovmResult>
  /**
   * Read one file from inside the machine `ownerRef` is bound to (after
   * `preflight`, before `release`). `path` is absolute in the machine and must
   * resolve inside the bound workspace; anything else is `refused`. Needed by
   * a caller whose command leaves its result in a file: that file lives in the
   * machine, not on the host.
   */
  readFile?(ownerRef: string, path: string, maxBytes: number): Promise<MicrovmFileRead>
  release?(ownerRef: string): Promise<void> | void
  dispose?(): Promise<void> | void
}

export type SandboxRuntimeRef = string

export type SandboxRuntimeErrorCode =
  | "invalid-binding"
  | "target-not-found"
  | "surface-disabled"
  | "runtime-released"
  | "microvm-unavailable"
  | "placement-unavailable"

export class SandboxRuntimeError extends Error {
  readonly code: SandboxRuntimeErrorCode

  constructor(code: SandboxRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SandboxRuntimeError"
    this.code = code
  }
}

export const HOST_FALLBACK_RUNTIME_REF: SandboxRuntimeRef = "sandbox-runtime:host-default"

export type { SandboxResourcePolicy } from "@cognia/agent-config-types"
export type { E2BBackend, WorkspaceHandle } from "@/lib/github/workspace"

/** Runtime operations are mounted on `ctx.sandbox` for ownership and permission governance. */
export type { PluginSandboxAPI } from "@/lib/plugin/api/sandbox-api"
