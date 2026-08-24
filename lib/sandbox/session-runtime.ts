import type { SandboxResourcePolicy } from "@cognia/agent-config-types"

import type { CallContext } from "@/lib/automation/client"
import { getSandboxConnection } from "@/lib/db/sandbox-connections"
import { transport } from "@/lib/tauri"
import type { SandboxConnectionRow, SandboxSessionBinding } from "@/types/sandbox"

import { validateSandboxSessionBinding } from "./binding"
import { assertSandboxOperationAllowed, SandboxCapabilityError } from "./lifecycle-contract"
import {
  getMicrovmExec,
  type MicrovmExecAdapter,
  type MicrovmExecPayload,
  type MicrovmResult,
} from "./microvm-bridge"
import { clampPolicyRequest, isPathUnderRoot } from "./policy-bridge"

export type SandboxRuntimeRef = string
export type SandboxConfine = NonNullable<CallContext["sandboxConfine"]>

export type SandboxRuntimeErrorCode =
  | "invalid-binding"
  | "target-not-found"
  | "surface-disabled"
  | "runtime-released"
  | "microvm-unavailable"
  /**
   * The session asked for a placement that could not be established, and the
   * surface refuses rather than running on this machine. Distinct from
   * `surface-disabled` (the user turned the surface off) because the user
   * turned this one ON and is owed an error, not a silent host downgrade.
   */
  | "placement-unavailable"

export class SandboxRuntimeError extends Error {
  readonly code: SandboxRuntimeErrorCode

  constructor(code: SandboxRuntimeErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "SandboxRuntimeError"
    this.code = code
  }
}

export type { MicrovmExecAdapter } from "./microvm-bridge"

export interface BindSandboxSessionInput {
  sessionId: string
  binding: SandboxSessionBinding
  policy: SandboxResourcePolicy | null
  confine: SandboxConfine | null
  sandboxEnabled: boolean
  computerUseEnabled: boolean
  workspaceRoot?: string
}

export interface SandboxSessionRuntimeDeps {
  getConnection(id: string): Promise<SandboxConnectionRow | undefined>
  getMicrovmAdapter(): MicrovmExecAdapter | null
  executeOsSandbox(payload: MicrovmExecPayload): Promise<MicrovmResult>
  makeRef(): SandboxRuntimeRef
}

/**
 * Surfaces whose requested placement could not be established. Present only on
 * a record minted by {@link SandboxSessionRuntime.bindUnplacedSession}; the
 * value is the operator-facing reason the bind was refused.
 */
interface UnplacedSurfaces {
  sandbox?: string
  computerUse?: string
}

interface RuntimeRecord extends BindSandboxSessionInput {
  ref: SandboxRuntimeRef
  fingerprint: string
  unplaced?: UnplacedSurfaces
}

function copyPolicy(policy: SandboxResourcePolicy | null): SandboxResourcePolicy | null {
  if (!policy) return null
  return Object.freeze({
    ...policy,
    ...(policy.writableRoots ? { writableRoots: [...policy.writableRoots] } : {}),
    ...(policy.readableRoots ? { readableRoots: [...policy.readableRoots] } : {}),
    ...(policy.networkAllowlist ? { networkAllowlist: [...policy.networkAllowlist] } : {}),
  })
}

function copyConfine(confine: SandboxConfine | null): SandboxConfine | null {
  if (!confine) return null
  return Object.freeze({
    ...confine,
    ...(confine.writable ? { writable: [...confine.writable] } : {}),
    ...(confine.readable ? { readable: [...confine.readable] } : {}),
    ...(confine.networkHosts ? { networkHosts: [...confine.networkHosts] } : {}),
  })
}

function fingerprint(input: BindSandboxSessionInput): string {
  return JSON.stringify({
    binding: input.binding,
    policy: input.policy,
    confine: input.confine,
    sandboxEnabled: input.sandboxEnabled,
    computerUseEnabled: input.computerUseEnabled,
    workspaceRoot: input.workspaceRoot,
  })
}

function operationContext(row: SandboxConnectionRow) {
  return {
    connectionId: row.id,
    provider: row.provider,
    driver: row.driver,
    capabilities: row.capabilities,
    state: row.state,
  }
}

/**
 * Placement for callers that never went through `resolveSendOptions` — a
 * workflow node, a plan step, an External Bridge orchestration call, a
 * plugin-to-plugin call, or the CLI rail. They have no send envelope to carry
 * a ref, and before the runtime existed they ran on the host OS tier with no
 * resolved policy. This record reproduces exactly that placement so those
 * paths keep working; a chat send always has its own ref and never lands here.
 */
export const HOST_FALLBACK_RUNTIME_REF: SandboxRuntimeRef = "sandbox-runtime:host-default"

/** Sentinel owner. No real `ChatSession.id` can collide with it. */
const HOST_FALLBACK_SESSION_ID = "__sandbox_host_fallback__"

const HOST_FALLBACK_RECORD: RuntimeRecord = Object.freeze({
  sessionId: HOST_FALLBACK_SESSION_ID,
  binding: Object.freeze({ shellTier: "os", computerTarget: "local" }) as SandboxSessionBinding,
  policy: null,
  confine: null,
  sandboxEnabled: true,
  computerUseEnabled: true,
  ref: HOST_FALLBACK_RUNTIME_REF,
  fingerprint: "host-default",
})

/**
 * One immutable placement binding per active session generation.
 *
 * The runtime deliberately routes only the two surfaces whose placement used
 * to drift (`sandbox_*` execution and Computer Use). Terminal, files, browser,
 * Task Workspace and external-agent modules keep their existing interfaces.
 */
export class SandboxSessionRuntime {
  private readonly activeBySession = new Map<string, SandboxRuntimeRef>()
  private readonly records = new Map<SandboxRuntimeRef, RuntimeRecord>()
  private readonly closedSessions = new Set<string>()

  constructor(private readonly deps: SandboxSessionRuntimeDeps) {
    this.records.set(HOST_FALLBACK_RUNTIME_REF, HOST_FALLBACK_RECORD)
  }

  async bindSession(input: BindSandboxSessionInput): Promise<SandboxRuntimeRef> {
    if (this.closedSessions.has(input.sessionId)) {
      const cleanupPending = [...this.records.values()].some(
        (record) => record.sessionId === input.sessionId
      )
      // Retry the cleanup that failed instead of refusing forever. A provider
      // blip during release must not leave the session permanently unable to
      // bind — and therefore unable to send at all. If the provider is still
      // down the retry throws and the next send tries again.
      if (cleanupPending) await this.releaseSession(input.sessionId)
      this.closedSessions.delete(input.sessionId)
    }
    const validation = validateSandboxSessionBinding(input.binding)
    if (!validation.ok) {
      throw new SandboxRuntimeError("invalid-binding", validation.message)
    }

    // Fast-path BEFORE the preflight: an unchanged binding must not pay a
    // connection read per send. Nothing is lost by skipping it — the surfaces
    // that need a live connection (`decorateComputerUseContext`) re-resolve and
    // re-assert it on every call, so a target that went away since the bind is
    // still caught at the moment it would have been used.
    const nextFingerprint = fingerprint(input)
    const activeRef = this.activeBySession.get(input.sessionId)
    const active = activeRef ? this.records.get(activeRef) : undefined
    if (active?.fingerprint === nextFingerprint) return active.ref

    await this.preflightMutableTarget(input)

    const ref = this.deps.makeRef()
    if (input.sandboxEnabled && input.binding.shellTier === "microvm") {
      const adapter = this.deps.getMicrovmAdapter()
      if (!adapter) {
        throw new SandboxRuntimeError(
          "microvm-unavailable",
          "The microVM sandbox was explicitly selected, but no E2B execution adapter is registered."
        )
      }
      await adapter.preflight?.(ref, input.workspaceRoot, input.sessionId)
    }

    const record: RuntimeRecord = Object.freeze({
      ...input,
      binding: Object.freeze({ ...input.binding }),
      policy: copyPolicy(input.policy),
      confine: copyConfine(input.confine),
      ref,
      fingerprint: nextFingerprint,
    })
    this.records.set(ref, record)
    this.activeBySession.set(input.sessionId, ref)
    this.retireRecord(activeRef)
    return ref
  }

  /**
   * Register the placement a session ASKED for when the bind could not be
   * established, so the surfaces that cannot honour it refuse instead of
   * silently running here.
   *
   * The resolved ceiling still rides on the record: a shell tier of `"os"` is
   * the host tier by request, so it keeps working — but it keeps working
   * *clamped*, which is what a caller falling back to the unpoliced host
   * default would have thrown away. Never throws: the caller is already on an
   * error path and must still be able to send.
   */
  bindUnplacedSession(input: BindSandboxSessionInput, cause: unknown): SandboxRuntimeRef {
    const reason = cause instanceof Error ? cause.message : String(cause)
    const unplaced: UnplacedSurfaces = {}
    // `os` is this machine by request; any other tier asked to leave it, and a
    // placement that was never established may not be answered with the host.
    if (input.sandboxEnabled && input.binding.shellTier !== "os") unplaced.sandbox = reason
    // A bound GUI target that never bound would drive the operator's own
    // desktop. The bind is atomic — a failure anywhere in it leaves the remote
    // target unproven — so the surface refuses rather than retargeting local.
    if (input.computerUseEnabled && input.binding.computerTarget === "bound") {
      unplaced.computerUse = reason
    }

    const ref = this.deps.makeRef()
    const previousRef = this.activeBySession.get(input.sessionId)
    this.records.set(
      ref,
      Object.freeze({
        ...input,
        binding: Object.freeze({ ...input.binding }),
        policy: copyPolicy(input.policy),
        confine: copyConfine(input.confine),
        ref,
        // Prefixed so the next send re-runs the real bind instead of matching
        // this degraded generation and never recovering.
        fingerprint: `unplaced:${fingerprint(input)}`,
        unplaced: Object.freeze(unplaced),
      })
    )
    this.activeBySession.set(input.sessionId, ref)
    this.retireRecord(previousRef)
    return ref
  }

  /**
   * Drop a superseded generation. Records are per *active* generation, so a
   * ref the session has moved off must stop being executable — otherwise a
   * queued call still holding it runs under the ceiling the user just
   * tightened away. Provider release is best-effort: the new generation has
   * already claimed its own resources, and a refusal here must not fail a bind
   * that already succeeded.
   */
  private retireRecord(ref: SandboxRuntimeRef | undefined): void {
    if (!ref || ref === HOST_FALLBACK_RUNTIME_REF) return
    const record = this.records.get(ref)
    if (!record) return
    this.records.delete(ref)
    if (record.binding.shellTier !== "microvm") return
    const adapter = this.deps.getMicrovmAdapter()
    if (!adapter?.release) return
    void Promise.resolve()
      .then(() => adapter.release!(ref))
      .catch(() => undefined)
  }

  async decorateComputerUseContext(
    ref: SandboxRuntimeRef,
    base: CallContext
  ): Promise<CallContext> {
    const record = this.requireRecord(ref)
    if (!record.computerUseEnabled) {
      throw new SandboxRuntimeError(
        "surface-disabled",
        "Computer Use is not enabled for this sandbox runtime binding."
      )
    }
    if (record.unplaced?.computerUse) {
      throw new SandboxRuntimeError(
        "placement-unavailable",
        `Computer Use is bound to a sandbox desktop that could not be placed, and will not fall back to this machine: ${record.unplaced.computerUse}`
      )
    }

    const result: CallContext = {
      ...base,
      ...(record.confine ? { sandboxConfine: record.confine } : {}),
    }
    if (record.binding.computerTarget === "local") return result

    const row = await this.requireConnection(record.binding.connectionId)
    assertSandboxOperationAllowed(operationContext(row), "gui")
    return { ...result, sandboxConnectionId: row.id }
  }

  async executeSandbox(
    ref: SandboxRuntimeRef,
    payload: MicrovmExecPayload
  ): Promise<MicrovmResult> {
    const record = this.requireRecord(ref)
    if (!record.sandboxEnabled) {
      throw new SandboxRuntimeError(
        "surface-disabled",
        "Sandboxed execution is not enabled for this runtime binding."
      )
    }
    if (record.unplaced?.sandbox) {
      throw new SandboxRuntimeError(
        "placement-unavailable",
        `The "${record.binding.shellTier}" shell tier could not be placed, and sandboxed execution will not fall back to this machine: ${record.unplaced.sandbox}`
      )
    }
    switch (record.binding.shellTier) {
      case "os":
        return this.deps.executeOsSandbox(payload)
      case "microvm": {
        const adapter = this.deps.getMicrovmAdapter()
        if (!adapter) {
          throw new SandboxRuntimeError(
            "microvm-unavailable",
            "The bound E2B execution adapter is no longer available; the operation was not run locally."
          )
        }
        // Stamp the session ceiling so the adapter can tell an operator cap it
        // cannot honour from a per-call request that simply needs less than
        // the instance offers.
        return adapter.execute(ref, {
          ...payload,
          ...(record.policy
            ? {
                ceiling: {
                  ...(record.policy.network ? { network: record.policy.network } : {}),
                  ...(record.policy.maxCpuSeconds
                    ? { maxCpuSeconds: record.policy.maxCpuSeconds }
                    : {}),
                  ...(record.policy.maxMemoryMb ? { maxMemoryMb: record.policy.maxMemoryMb } : {}),
                },
              }
            : {}),
        })
      }
      case "cua-desktop":
        // Unreachable in practice — `preflightMutableTarget` refuses this tier
        // before a record exists. Kept only for switch exhaustiveness, so it
        // must not pay a connection round-trip to restate the same refusal.
        throw new SandboxRuntimeError(
          "surface-disabled",
          "The cua-desktop shell tier has no verified workspace execution adapter; host fallback is forbidden."
        )
    }
  }

  clampRequest<T extends MicrovmExecPayload["request"]>(ref: SandboxRuntimeRef, request: T): T {
    return clampPolicyRequest(request, this.requireRecord(ref).policy)
  }

  assertWritablePath(ref: SandboxRuntimeRef, path: string, label = "path"): void {
    const roots = this.requireRecord(ref).policy?.writableRoots ?? []
    if (roots.length > 0 && !roots.some((root) => isPathUnderRoot(path, root))) {
      throw new Error(
        `sandbox: ${label} '${path}' is outside the configured writable roots — widen ` +
          "Settings → Sandbox writable roots or choose a path inside them."
      )
    }
  }

  async releaseSession(sessionId: string): Promise<void> {
    if (sessionId === HOST_FALLBACK_SESSION_ID) return
    this.closedSessions.add(sessionId)
    this.activeBySession.delete(sessionId)
    const owned = [...this.records.values()].filter((record) => record.sessionId === sessionId)
    const adapter = this.deps.getMicrovmAdapter()
    const failures: unknown[] = []
    // `allSettled`, not `all`: one provider that refuses to close must not
    // strand the other generations' records, which is what made a single
    // failure brick the session id for the rest of the process lifetime.
    // Records whose release DID fail are kept so the next attempt retries them.
    const retained = new Set<SandboxRuntimeRef>()
    if (adapter?.release) {
      const pending = owned.filter((record) => record.binding.shellTier === "microvm")
      const settled = await Promise.allSettled(pending.map((r) => adapter.release!(r.ref)))
      settled.forEach((outcome, index) => {
        if (outcome.status !== "rejected") return
        failures.push(outcome.reason)
        retained.add(pending[index].ref)
      })
    }
    for (const record of owned) {
      if (!retained.has(record.ref)) this.records.delete(record.ref)
    }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `Sandbox runtime for session "${sessionId}" could not release every provider resource.`
      )
    }
    // Nothing left to clean up — drop the tombstone so the set cannot grow
    // once per session id for the lifetime of the process.
    this.closedSessions.delete(sessionId)
  }

  /**
   * The ref currently bound for `sessionId`, if any. For rails that dispatch
   * plugin tools without a send envelope to carry the ref (the CLI) but do
   * own a session id.
   */
  activeRefForSession(sessionId: string | null | undefined): SandboxRuntimeRef | undefined {
    if (!sessionId) return undefined
    return this.activeBySession.get(sessionId)
  }

  /**
   * Test-only — drop every binding without touching provider resources. The
   * module singleton outlives an individual Jest test, so without this a
   * binding left behind by one test is matched by the fingerprint fast-path in
   * the next and the second test silently exercises the first one's record.
   */
  __resetForTesting(): void {
    this.activeBySession.clear()
    this.records.clear()
    this.closedSessions.clear()
    this.records.set(HOST_FALLBACK_RUNTIME_REF, HOST_FALLBACK_RECORD)
  }

  private requireRecord(ref: SandboxRuntimeRef): RuntimeRecord {
    const record = this.records.get(ref)
    if (!record || this.closedSessions.has(record.sessionId)) {
      throw new SandboxRuntimeError(
        "runtime-released",
        "The sandbox runtime binding is missing or has already been released."
      )
    }
    return record
  }

  private async requireConnection(id: string | undefined): Promise<SandboxConnectionRow> {
    if (!id) {
      throw new SandboxRuntimeError(
        "invalid-binding",
        "The sandbox runtime requires a bound connection, but none was selected."
      )
    }
    const row = await this.deps.getConnection(id)
    if (!row) {
      throw new SandboxRuntimeError(
        "target-not-found",
        `Sandbox connection "${id}" no longer exists.`
      )
    }
    return row
  }

  private async preflightMutableTarget(input: BindSandboxSessionInput): Promise<void> {
    if (input.computerUseEnabled && input.binding.computerTarget === "bound") {
      const row = await this.requireConnection(input.binding.connectionId)
      assertSandboxOperationAllowed(operationContext(row), "gui")
    }
    if (input.sandboxEnabled && input.binding.shellTier === "cua-desktop") {
      const row = await this.requireConnection(input.binding.connectionId)
      throw new SandboxCapabilityError({
        code: "unsupported-operation",
        operation: "workspaceExec",
        provider: row.provider,
        driver: row.driver,
        message:
          "The cua-desktop shell tier is unavailable because this connection has no verified workspace execution adapter.",
      })
    }
  }
}

function makeRuntimeRef(): SandboxRuntimeRef {
  return `sandbox-runtime:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`
}

function defaultMicrovmAdapter(): MicrovmExecAdapter | null {
  return getMicrovmExec()
}

async function executeOsSandbox(payload: MicrovmExecPayload): Promise<MicrovmResult> {
  const osPayload = {
    ...payload,
    command: {
      ...payload.command,
      stdin:
        payload.command.stdin == null
          ? null
          : Array.from(new TextEncoder().encode(payload.command.stdin)),
    },
  }
  return transport.call<MicrovmResult>(
    "sandbox_exec",
    osPayload as unknown as Record<string, unknown>
  )
}

export const sandboxSessionRuntime = new SandboxSessionRuntime({
  getConnection: getSandboxConnection,
  getMicrovmAdapter: defaultMicrovmAdapter,
  executeOsSandbox,
  makeRef: makeRuntimeRef,
})

/** Test-only — wipe every binding held by the module singleton. */
export function __resetSandboxSessionRuntimeForTesting(): void {
  sandboxSessionRuntime.__resetForTesting()
}
