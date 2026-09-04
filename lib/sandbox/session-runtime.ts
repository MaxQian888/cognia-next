import type { SandboxResourcePolicy } from "@cognia/agent-config-types"
import {
  HOST_FALLBACK_RUNTIME_REF,
  SandboxRuntimeError,
  type SandboxRuntimeRef,
} from "@cognia/plugin-sdk/api/sandbox"

import type { CallContext } from "@/lib/automation/client"
import type { AutomationAuditLogRow } from "@/lib/automation/audit"
import { getSandboxConnection } from "@/lib/db/sandbox-connections"
import { transport } from "@/lib/tauri"
import { getOsSandboxExec } from "@/lib/sandbox/os-exec-bridge"
import type { SandboxConnectionRow, SandboxSessionBinding } from "@/types/sandbox"

import { validateSandboxSessionBinding } from "./binding"
import { runSandboxConnectionOperation } from "./connection-lifecycle"
import { assertSandboxOperationAllowed } from "./lifecycle-contract"
import {
  getMicrovmExec,
  type MicrovmExecAdapter,
  type MicrovmExecPayload,
  type MicrovmResult,
} from "./microvm-bridge"
import { clampPolicyRequest, isPathUnderRoot } from "./policy-bridge"

export type SandboxConfine = NonNullable<CallContext["sandboxConfine"]>

export {
  HOST_FALLBACK_RUNTIME_REF,
  SandboxRuntimeError,
  type SandboxRuntimeErrorCode,
  type SandboxRuntimeRef,
} from "@cognia/plugin-sdk/api/sandbox"

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
  recordAudit?(row: AutomationAuditLogRow): Promise<void>
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
  microvmAdapter?: MicrovmExecAdapter
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
  private readonly cleanupByRef = new Map<SandboxRuntimeRef, RuntimeRecord>()
  private readonly cleanupInFlight = new Map<SandboxRuntimeRef, Promise<void>>()
  private readonly closedSessions = new Set<string>()

  constructor(private readonly deps: SandboxSessionRuntimeDeps) {
    this.records.set(HOST_FALLBACK_RUNTIME_REF, HOST_FALLBACK_RECORD)
  }

  async bindSession(input: BindSandboxSessionInput): Promise<SandboxRuntimeRef> {
    if (this.closedSessions.has(input.sessionId)) {
      const cleanupPending = [...this.cleanupByRef.values()].some(
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
    let microvmAdapter: MicrovmExecAdapter | undefined
    if (input.sandboxEnabled && input.binding.shellTier === "microvm") {
      microvmAdapter = this.deps.getMicrovmAdapter() ?? undefined
      if (!microvmAdapter) {
        throw new SandboxRuntimeError(
          "microvm-unavailable",
          "The microVM sandbox was explicitly selected, but no E2B execution adapter is registered."
        )
      }
      await microvmAdapter.preflight?.(ref, input.workspaceRoot, input.sessionId)
    }

    const record: RuntimeRecord = Object.freeze({
      ...input,
      binding: Object.freeze({ ...input.binding }),
      policy: copyPolicy(input.policy),
      confine: copyConfine(input.confine),
      ref,
      fingerprint: nextFingerprint,
      ...(microvmAdapter ? { microvmAdapter } : {}),
    })
    this.records.set(ref, record)
    this.activeBySession.set(input.sessionId, ref)
    this.retireRecord(activeRef)
    return ref
  }

  /**
   * Re-establish a placement against the working directory the turn actually
   * resolved to.
   *
   * `resolveSendOptions` binds while assembling the send envelope, but a
   * session whose execution binding is created *during* the turn — a managed
   * worktree acquires its bundle after the envelope is built — only learns its
   * real root afterwards. Re-binding keeps `workspaceRoot`, which the microVM
   * preflight claims against and which the confine roots are measured from, in
   * agreement with the directory the agent is writing to.
   *
   * Re-binding an unplaced record is deliberate rather than wasteful: the root
   * is exactly what a microVM preflight refuses on, so the corrected root is
   * often what turns the refusal into a real placement.
   *
   * A no-op when the root is unchanged — `bindSession` fingerprints its input
   * and returns the same ref without re-running the preflight. Never throws:
   * the turn already holds a usable (if coarser) placement, and a refusal here
   * must not take down a send that is otherwise ready to go.
   */
  async rebindWorkspaceRoot(
    ref: SandboxRuntimeRef,
    workspaceRoot: string | undefined
  ): Promise<SandboxRuntimeRef> {
    if (ref === HOST_FALLBACK_RUNTIME_REF) return ref
    const record = this.records.get(ref)
    if (!record || record.workspaceRoot === workspaceRoot) return ref
    const input: BindSandboxSessionInput = {
      sessionId: record.sessionId,
      binding: record.binding,
      policy: record.policy,
      confine: record.confine,
      sandboxEnabled: record.sandboxEnabled,
      computerUseEnabled: record.computerUseEnabled,
      workspaceRoot,
    }
    try {
      return await this.bindSession(input)
    } catch (err) {
      return this.bindUnplacedSession(input, err)
    }
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
    if (!record.microvmAdapter?.release) return
    this.cleanupByRef.set(ref, record)
    void this.releaseCleanupRecord(record).catch(() => undefined)
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
      const error = new SandboxRuntimeError(
        "placement-unavailable",
        `The "${record.binding.shellTier}" shell tier could not be placed, and sandboxed execution will not fall back to this machine: ${record.unplaced.sandbox}`
      )
      if (record.binding.shellTier === "microvm") {
        this.recordMicrovmAudit(payload, {
          error,
          durationMs: 0,
          termination: "placement_unavailable",
        })
      }
      throw error
    }
    switch (record.binding.shellTier) {
      case "os":
        return this.deps.executeOsSandbox(payload)
      case "microvm": {
        const adapter = record.microvmAdapter
        if (!adapter) {
          throw new SandboxRuntimeError(
            "microvm-unavailable",
            "The bound E2B execution adapter is no longer available; the operation was not run locally."
          )
        }
        // Stamp the session ceiling so the adapter can tell an operator cap it
        // cannot honour from a per-call request that simply needs less than
        // the instance offers.
        const started = Date.now()
        try {
          const result = await adapter.execute(ref, {
            ...payload,
            ...(record.policy
              ? {
                  ceiling: {
                    ...(record.policy.network ? { network: record.policy.network } : {}),
                    ...(record.policy.maxCpuSeconds
                      ? { maxCpuSeconds: record.policy.maxCpuSeconds }
                      : {}),
                    ...(record.policy.maxMemoryMb
                      ? { maxMemoryMb: record.policy.maxMemoryMb }
                      : {}),
                  },
                }
              : {}),
          })
          this.recordMicrovmAudit(payload, {
            result,
            durationMs: Math.max(result.duration, Date.now() - started),
          })
          return result
        } catch (error) {
          this.recordMicrovmAudit(payload, {
            error,
            durationMs: Date.now() - started,
          })
          throw error
        }
      }
      case "cua-desktop": {
        // Runs the command inside the bound machine via the provider adapter.
        // `preflightMutableTarget` has already established that the connection
        // advertises `workspaceExec`, and the adapter attests the per-call
        // policy against the container's frozen confinement before running
        // anything. A refusal at either point stays a refusal: there is no
        // fallback to this host.
        const row = await this.requireConnection(record.binding.connectionId)
        const started = Date.now()
        try {
          const exec = await runSandboxConnectionOperation(row, "workspaceExec", {
            exec: {
              argv: payload.command.argv,
              cwd: payload.command.cwd,
              env: payload.command.env,
              stdin: payload.command.stdin ?? undefined,
              timeoutMs: payload.command.timeout,
              policy: payload.request,
            },
          })
          if (!exec.exec) {
            throw new SandboxRuntimeError(
              "surface-disabled",
              "The bound machine accepted the command but returned no result."
            )
          }
          const result: MicrovmResult = {
            exit_code: exec.exec.exitCode,
            stdout: exec.exec.stdout,
            stderr: exec.exec.stderr,
            duration: exec.exec.durationMs,
            timed_out: exec.exec.timedOut,
            ...(exec.exec.stdoutTruncated ? { stdout_truncated: true } : {}),
            ...(exec.exec.stderrTruncated ? { stderr_truncated: true } : {}),
          }
          this.recordMicrovmAudit(payload, {
            result,
            durationMs: Math.max(result.duration, Date.now() - started),
          })
          return result
        } catch (error) {
          this.recordMicrovmAudit(payload, { error, durationMs: Date.now() - started })
          throw error
        }
      }
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
    const previouslyRetired = [...this.cleanupByRef.values()].filter(
      (record) => record.sessionId === sessionId
    )
    // A best-effort rebind retirement may still be settling when deletion
    // arrives. Observe that attempt first, then retry the retained ledger
    // entry below instead of treating the already-known failure as the
    // deletion attempt itself.
    await Promise.allSettled(
      previouslyRetired.map((record) => this.cleanupInFlight.get(record.ref) ?? Promise.resolve())
    )
    const owned = [...this.records.values()].filter((record) => record.sessionId === sessionId)
    for (const record of owned) {
      this.records.delete(record.ref)
      if (record.binding.shellTier === "microvm" && record.microvmAdapter?.release) {
        this.cleanupByRef.set(record.ref, record)
      }
    }
    const pending = [...this.cleanupByRef.values()].filter(
      (record) => record.sessionId === sessionId
    )
    const settled = await Promise.allSettled(
      pending.map((record) => this.releaseCleanupRecord(record))
    )
    const failures = settled.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : []
    )
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

  private releaseCleanupRecord(record: RuntimeRecord): Promise<void> {
    const existing = this.cleanupInFlight.get(record.ref)
    if (existing) return existing
    const release = record.microvmAdapter?.release
    if (!release) {
      this.cleanupByRef.delete(record.ref)
      return Promise.resolve()
    }
    const pending = Promise.resolve()
      .then(() => release.call(record.microvmAdapter, record.ref))
      .then(() => {
        this.cleanupByRef.delete(record.ref)
      })
      .finally(() => {
        if (this.cleanupInFlight.get(record.ref) === pending) {
          this.cleanupInFlight.delete(record.ref)
        }
      })
    this.cleanupInFlight.set(record.ref, pending)
    return pending
  }

  private recordMicrovmAudit(
    payload: MicrovmExecPayload,
    outcome: {
      result?: MicrovmResult
      error?: unknown
      durationMs: number
      termination?: string
    }
  ): void {
    const result = outcome.result
    const termination =
      outcome.termination ??
      (outcome.error
        ? "provider_error"
        : result?.timed_out
          ? "timeout"
          : result?.exit_code === 0
            ? "completed"
            : "exit_nonzero")
    const reason = [
      "tier=microvm",
      "provider=e2b",
      `termination=${termination}`,
      `requested_timeout_seconds=${payload.command.timeout}`,
      `timeout=${result?.timed_out ?? false}`,
      `stdout_truncated=${result?.stdout_truncated ?? false}`,
      `stderr_truncated=${result?.stderr_truncated ?? false}`,
      `exit_code=${result?.exit_code ?? "none"}`,
    ].join(";")
    const row: AutomationAuditLogRow = {
      id: globalThis.crypto?.randomUUID?.() ?? `sandbox-audit:${Date.now()}-${Math.random()}`,
      ts: Date.now(),
      surface: "sandbox",
      pluginId: "cognia-sandboxed-tools",
      command: payload.tool,
      processName: "microvm:e2b",
      windowTitle: payload.command.cwd,
      decision: outcome.error ? "deny" : "allow",
      reason,
      durationMs: outcome.durationMs,
      error:
        outcome.error instanceof Error
          ? outcome.error.message
          : outcome.error == null
            ? null
            : String(outcome.error),
    }
    void this.deps.recordAudit?.(row).catch((error) => {
      console.warn("sandbox microVM audit persist failed", error)
    })
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
    this.cleanupByRef.clear()
    this.cleanupInFlight.clear()
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
      // The tier is available only for a connection whose provider actually
      // carries workspace execution. `assertSandboxOperationAllowed` refuses
      // with `unsupported-operation` otherwise, which is still the whole
      // answer for cua-cloud and lume: they have no adapter at all.
      const row = await this.requireConnection(input.binding.connectionId)
      assertSandboxOperationAllowed(operationContext(row), "workspaceExec")
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
  if (osSandboxExecOverride) {
    return osSandboxExecOverride(osPayload as unknown as MicrovmExecPayload)
  }
  // A Node host (the CLI, the supervised brain) registers an executor at
  // bootstrap because `transport.call("sandbox_exec")` is a Tauri `invoke` and
  // its stdio transport refuses the name outright. Preferring the registered
  // one is the whole difference between the OS tier existing on that host and
  // not. The desktop registers none and keeps the `invoke` path.
  const hostExecutor = getOsSandboxExec()
  if (hostExecutor) {
    return hostExecutor.execute(osPayload as unknown as MicrovmExecPayload)
  }
  try {
    return await transport.call<MicrovmResult>(
      "sandbox_exec",
      osPayload as unknown as Record<string, unknown>
    )
  } catch (error) {
    // The sandboxed tools are offered on every host that could have a backend,
    // because whether one is present is a runtime fact and a plugin manifest
    // can only state a static one. A host with neither the Tauri command nor a
    // registered executor lands here, and `tauri-only command from web mode:
    // sandbox_exec` explains nothing to whoever reads the tool result. Naming
    // the missing thing is the difference between a refusal a user can act on
    // and one that reads like a bug.
    throw new SandboxRuntimeError(
      "placement-unavailable",
      `This host has no OS sandbox backend, so the call was refused rather than run unconfined. ` +
        `The desktop app provides one; the cognia-agent CLI provides one through its ` +
        `cognia-sandbox-exec helper. Underlying error: ${
          error instanceof Error ? error.message : String(error)
        }`
    )
  }
}

async function recordSandboxAudit(row: AutomationAuditLogRow): Promise<void> {
  const { recordAuditRow } = await import("@/lib/automation/audit")
  await recordAuditRow(row)
}

let osSandboxExecOverride: ((payload: MicrovmExecPayload) => Promise<MicrovmResult>) | undefined

/** Test-only seam scoped to sandbox execution; avoids replacing host-wide IPC. */
export function __setSandboxOsExecForTesting(
  execute: ((payload: MicrovmExecPayload) => Promise<MicrovmResult>) | undefined
): void {
  osSandboxExecOverride = execute
}

export const sandboxSessionRuntime = new SandboxSessionRuntime({
  getConnection: getSandboxConnection,
  getMicrovmAdapter: defaultMicrovmAdapter,
  executeOsSandbox,
  makeRef: makeRuntimeRef,
  recordAudit: recordSandboxAudit,
})

/** Test-only — wipe every binding held by the module singleton. */
export function __resetSandboxSessionRuntimeForTesting(): void {
  sandboxSessionRuntime.__resetForTesting()
  osSandboxExecOverride = undefined
}
