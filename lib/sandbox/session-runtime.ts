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
import { clampPolicyRequest } from "./policy-bridge"
import { isPathUnderRoot } from "./policy-bridge"

export type SandboxRuntimeRef = string
export type SandboxConfine = NonNullable<CallContext["sandboxConfine"]>

export type SandboxRuntimeErrorCode =
  | "invalid-binding"
  | "target-not-found"
  | "surface-disabled"
  | "runtime-released"
  | "microvm-unavailable"

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

interface RuntimeRecord extends BindSandboxSessionInput {
  ref: SandboxRuntimeRef
  fingerprint: string
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

  constructor(private readonly deps: SandboxSessionRuntimeDeps) {}

  async bindSession(input: BindSandboxSessionInput): Promise<SandboxRuntimeRef> {
    if (this.closedSessions.has(input.sessionId)) {
      const cleanupPending = [...this.records.values()].some(
        (record) => record.sessionId === input.sessionId
      )
      if (cleanupPending) {
        throw new SandboxRuntimeError(
          "runtime-released",
          "The previous sandbox runtime generation is still awaiting provider cleanup."
        )
      }
      this.closedSessions.delete(input.sessionId)
    }
    const validation = validateSandboxSessionBinding(input.binding)
    if (!validation.ok) {
      throw new SandboxRuntimeError("invalid-binding", validation.message)
    }

    await this.preflightMutableTarget(input)

    const nextFingerprint = fingerprint(input)
    const activeRef = this.activeBySession.get(input.sessionId)
    const active = activeRef ? this.records.get(activeRef) : undefined
    if (active?.fingerprint === nextFingerprint) return active.ref

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
    return ref
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
        return adapter.execute(ref, payload)
      }
      case "cua-desktop": {
        const row = await this.requireConnection(record.binding.connectionId)
        throw new SandboxCapabilityError({
          code: "unsupported-operation",
          operation: "workspaceExec",
          provider: row.provider,
          driver: row.driver,
          message:
            "The bound Computer Use desktop does not provide verified workspace execution; host fallback is forbidden.",
        })
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
    this.closedSessions.add(sessionId)
    this.activeBySession.delete(sessionId)
    const owned = [...this.records.values()].filter((record) => record.sessionId === sessionId)
    const adapter = this.deps.getMicrovmAdapter()
    if (adapter?.release) {
      await Promise.all(
        owned
          .filter((record) => record.binding.shellTier === "microvm")
          .map((record) => adapter.release!(record.ref))
      )
    }
    for (const record of owned) this.records.delete(record.ref)
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
