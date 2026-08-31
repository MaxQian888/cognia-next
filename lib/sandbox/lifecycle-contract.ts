/**
 * Provider-neutral sandbox lifecycle contract.
 *
 * Every provider adapter (Docker, cua.ai Cloud, Lume) implements
 * {@link SandboxProviderAdapter}. Callers never branch on `provider` — they go
 * through {@link runSandboxOperation}, which checks the connection's capability
 * matrix first and refuses with a typed {@link SandboxCapabilityError} when the
 * operation is not supported.
 *
 * **The refusal is the whole point.** The behaviour being replaced is a
 * best-effort fallback to the host: ask a Docker connection to `suspend`, get
 * no error, and carry on believing the machine is paused. An unsupported
 * operation must fail loudly and must never execute on the user's own desktop.
 */

import type {
  SandboxCapabilities,
  SandboxConnectionDriver,
  SandboxConnectionProvider,
  SandboxLifecycleOperation,
  SandboxLifecycleState,
} from "@/types/sandbox"
import { supportsSandboxOperation } from "./connection-capabilities"

/** Machine-readable refusal reasons. */
export type SandboxCapabilityErrorCode =
  /** The provider/driver pair does not implement this operation at all. */
  | "unsupported-operation"
  /** Supported, but the adapter did not provide an implementation. */
  | "not-implemented"
  /** Needs a credential that is not in the keyring. */
  | "missing-credentials"
  /** Needs a live connection; none is established. */
  | "not-connected"
  /** The operation is refused in the connection's current lifecycle state. */
  | "invalid-state"

export class SandboxCapabilityError extends Error {
  readonly code: SandboxCapabilityErrorCode
  readonly operation: SandboxLifecycleOperation
  readonly provider: SandboxConnectionProvider
  readonly driver: SandboxConnectionDriver

  constructor(args: {
    code: SandboxCapabilityErrorCode
    operation: SandboxLifecycleOperation
    provider: SandboxConnectionProvider
    driver: SandboxConnectionDriver
    message?: string
  }) {
    super(
      args.message ??
        `Sandbox operation "${args.operation}" is not available for provider "${args.provider}" via driver "${args.driver}" (${args.code}).`
    )
    this.name = "SandboxCapabilityError"
    this.code = args.code
    this.operation = args.operation
    this.provider = args.provider
    this.driver = args.driver
  }
}

/** Identity + state an adapter needs to act on one connection. */
export interface SandboxOperationContext {
  connectionId: string
  provider: SandboxConnectionProvider
  driver: SandboxConnectionDriver
  capabilities: SandboxCapabilities
  state: SandboxLifecycleState
  signal?: AbortSignal
}

export interface SandboxHealthReport {
  reachable: boolean
  state: SandboxLifecycleState
  error?: string
}

export interface SandboxGuiRequest {
  action: string
  params?: Record<string, unknown>
}

export interface SandboxExecRequest {
  /**
   * Argument vector. Every adapter passes these through as separate arguments
   * and never joins them into a shell string, so a path or an environment
   * value containing a space or a quote cannot become a second command.
   */
  argv: string[]
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  timeoutMs?: number
}

export interface SandboxExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  /**
   * The adapter gave up waiting. The process inside the machine may still be
   * running, so this is not the same as "the work stopped".
   */
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

/**
 * What a provider adapter implements. Every method is optional: absence is
 * indistinguishable from an unsupported capability, and both produce a typed
 * error rather than a host fallback.
 */
export interface SandboxProviderAdapter {
  readonly provider: SandboxConnectionProvider
  readonly driver: SandboxConnectionDriver

  create?(ctx: SandboxOperationContext): Promise<void>
  connect?(ctx: SandboxOperationContext): Promise<void>
  start?(ctx: SandboxOperationContext): Promise<void>
  suspend?(ctx: SandboxOperationContext): Promise<void>
  resume?(ctx: SandboxOperationContext): Promise<void>
  stop?(ctx: SandboxOperationContext): Promise<void>
  delete?(ctx: SandboxOperationContext): Promise<void>
  health?(ctx: SandboxOperationContext): Promise<SandboxHealthReport>
  gui?(ctx: SandboxOperationContext, request: SandboxGuiRequest): Promise<unknown>
  workspaceRead?(ctx: SandboxOperationContext, path: string): Promise<string>
  workspaceExec?(
    ctx: SandboxOperationContext,
    request: SandboxExecRequest
  ): Promise<SandboxExecResult>
}

/**
 * Lifecycle states in which an operation is refused, regardless of capability.
 * Omitted operations are allowed in every state — `health` in particular must
 * work while the machine is broken, which is exactly when it is asked.
 */
const FORBIDDEN_STATES: Partial<
  Record<SandboxLifecycleOperation, readonly SandboxLifecycleState[]>
> = {
  create: ["running", "starting", "suspended", "suspending", "resuming"],
  start: ["running", "deleting"],
  suspend: ["stopped", "uninitialized", "deleting"],
  resume: ["running", "uninitialized", "deleting"],
  stop: ["uninitialized", "deleting"],
  gui: ["uninitialized", "stopped", "deleting"],
  workspaceRead: ["uninitialized", "stopped", "deleting"],
  workspaceExec: ["uninitialized", "stopped", "deleting"],
}

/**
 * Assert `operation` may run on this connection right now. Throws
 * {@link SandboxCapabilityError} — it never returns a boolean, so a caller
 * cannot accidentally ignore the refusal.
 */
export function assertSandboxOperationAllowed(
  ctx: SandboxOperationContext,
  operation: SandboxLifecycleOperation
): void {
  if (!supportsSandboxOperation(ctx.capabilities, operation)) {
    throw new SandboxCapabilityError({
      code: "unsupported-operation",
      operation,
      provider: ctx.provider,
      driver: ctx.driver,
    })
  }
  const forbidden = FORBIDDEN_STATES[operation]
  if (forbidden?.includes(ctx.state)) {
    throw new SandboxCapabilityError({
      code: "invalid-state",
      operation,
      provider: ctx.provider,
      driver: ctx.driver,
      message: `Sandbox operation "${operation}" is not valid while the connection is "${ctx.state}".`,
    })
  }
}

/**
 * Capability-checked dispatch. The single door every caller uses.
 *
 * `invoke` receives the adapter method already resolved; when the adapter did
 * not implement it despite advertising the capability, the call is refused with
 * `not-implemented` rather than falling through to the host.
 */
export async function runSandboxOperation<T>(
  adapter: SandboxProviderAdapter,
  ctx: SandboxOperationContext,
  operation: SandboxLifecycleOperation,
  invoke: (adapter: SandboxProviderAdapter) => Promise<T> | undefined
): Promise<T> {
  assertSandboxOperationAllowed(ctx, operation)
  const result = invoke(adapter)
  if (result === undefined) {
    throw new SandboxCapabilityError({
      code: "not-implemented",
      operation,
      provider: ctx.provider,
      driver: ctx.driver,
      message: `Provider "${ctx.provider}" advertises "${operation}" but the adapter does not implement it.`,
    })
  }
  return result
}
