// AgentExecutionHandle (ADR-0090 Phase 3, plan §3.5).
//
// Capability-gated command facade over the existing sidecar IPC
// (`lib/claude/ipc.ts` — this is a FACADE, not a second IPC layer). Every
// command carries an idempotency `commandId` the host dedupes on, unsupported
// operations throw a typed `AgentCapabilityError` BEFORE any IPC, and
// `setModel` accepts only models frozen into the spec's bindings.

import type {
  AgentCapabilityId,
  AgentEventEnvelope,
  ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"

import * as ipc from "@/lib/claude/ipc"

export class AgentCapabilityError extends Error {
  readonly capability: AgentCapabilityId

  constructor(capability: AgentCapabilityId, command: string) {
    super(`capability "${capability}" is not supported by this session's runtime (${command})`)
    this.name = "AgentCapabilityError"
    this.capability = capability
  }
}

export class FrozenModelBindingError extends Error {
  constructor(model: string) {
    super(`model "${model}" is not one of this session's frozen bindings`)
    this.name = "FrozenModelBindingError"
  }
}

let handleCounter = 0

export interface AgentExecutionHandle {
  readonly sessionId: string
  readonly spec: ResolvedAgentExecutionSpec
  events(onEnvelope: (envelope: AgentEventEnvelope) => void): Promise<() => void>
  interrupt(): Promise<void>
  cancel(): Promise<void>
  compact(focus?: string): Promise<void>
  resolvePermission(
    requestId: string,
    decision: "allow" | "allow_always" | "deny",
    options?: { message?: string; updatedInput?: Record<string, unknown> }
  ): Promise<void>
  setModel(model: string): Promise<void>
  setPermissionMode(mode: "default" | "acceptEdits" | "bypassPermissions" | "plan"): Promise<void>
}

interface HandleDeps {
  ipc: Pick<
    typeof ipc,
    | "interruptSession"
    | "compactSession"
    | "setSessionMode"
    | "setSessionModel"
    | "subscribeAgentEvents"
  > & {
    resolvePermission: (
      sessionId: string,
      requestId: string,
      decision: string,
      message?: string,
      updatedInput?: Record<string, unknown>
    ) => Promise<void>
  }
  closeSession: (sessionId: string) => Promise<void>
}

function requireCapability(
  spec: ResolvedAgentExecutionSpec,
  capability: AgentCapabilityId,
  command: string
): void {
  if (!spec.capabilities.effective.includes(capability)) {
    throw new AgentCapabilityError(capability, command)
  }
}

export function nextCommandId(): string {
  handleCounter += 1
  return `cmd-${handleCounter}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Create a handle bound to a resolved spec. `deps` is injectable for tests;
 * production callers omit it and get the real IPC.
 */
export function createAgentExecutionHandle(
  sessionId: string,
  spec: ResolvedAgentExecutionSpec,
  deps?: Partial<HandleDeps>
): AgentExecutionHandle {
  const io: HandleDeps = {
    ipc: {
      interruptSession: deps?.ipc?.interruptSession ?? ipc.interruptSession,
      compactSession: deps?.ipc?.compactSession ?? ipc.compactSession,
      setSessionMode: deps?.ipc?.setSessionMode ?? ipc.setSessionMode,
      setSessionModel: deps?.ipc?.setSessionModel ?? ipc.setSessionModel,
      subscribeAgentEvents: deps?.ipc?.subscribeAgentEvents ?? ipc.subscribeAgentEvents,
      resolvePermission:
        deps?.ipc?.resolvePermission ??
        (async (sid, requestId, decision, message, updatedInput) => {
          const { transport } = await import("@/lib/tauri")
          await transport.call("agent_resolve_permission", {
            sessionId: sid,
            requestId,
            decision,
            message,
            updatedInput,
            commandId: nextCommandId(),
          })
        }),
    },
    closeSession:
      deps?.closeSession ??
      (async (sid) => {
        const { transport } = await import("@/lib/tauri")
        await transport.call("agent_close_session", { sessionId: sid, commandId: nextCommandId() })
      }),
  }

  const frozenModels = new Set(
    [spec.modelBindings.primary, spec.modelBindings.fast, spec.modelBindings.powerful].filter(
      (m): m is string => Boolean(m)
    )
  )

  return {
    sessionId,
    spec,
    async events(onEnvelope) {
      const unlisten = await io.ipc.subscribeAgentEvents((envelope) => {
        if (envelope.sessionId === sessionId) onEnvelope(envelope)
      })
      return unlisten
    },
    async interrupt() {
      await io.ipc.interruptSession(sessionId)
    },
    async cancel() {
      await io.closeSession(sessionId)
    },
    async compact(focus) {
      requireCapability(spec, "compaction", "compact")
      await io.ipc.compactSession(sessionId, focus)
    },
    async resolvePermission(requestId, decision, options) {
      requireCapability(spec, "permissions.interrupt-resume", "resolvePermission")
      await io.ipc.resolvePermission(
        sessionId,
        requestId,
        decision,
        options?.message,
        options?.updatedInput
      )
    },
    async setModel(model) {
      requireCapability(spec, "set-model", "setModel")
      if (!frozenModels.has(model)) {
        throw new FrozenModelBindingError(model)
      }
      await io.ipc.setSessionModel(sessionId, model)
    },
    async setPermissionMode(mode) {
      requireCapability(spec, "permissions.set-mode", "setPermissionMode")
      await io.ipc.setSessionMode(sessionId, mode)
    },
  }
}
