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
}

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
  execute(ownerRef: string, payload: MicrovmExecPayload): Promise<MicrovmResult>
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
