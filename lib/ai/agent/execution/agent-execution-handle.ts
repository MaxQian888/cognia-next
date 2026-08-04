// AgentExecutionHandle (ADR-0090 Phase 3, plan §3.5).
//
// Capability-gated command facade over the existing sidecar IPC
// (`lib/claude/ipc.ts` — this is a FACADE, not a second IPC layer). Every
// command carries an idempotency `commandId` the host dedupes on, unsupported
// operations throw a typed `AgentCapabilityError` BEFORE any IPC, and
// `setModel` accepts only models frozen into the spec's bindings.

import type { AgentPermissionMode, SessionControlMethod } from "@cognia/agent-config-types"
import { SESSION_CONTROL_CAPABILITIES } from "@cognia/agent-config-types"
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
    options?: {
      message?: string
      updatedInput?: Record<string, unknown>
      /**
       * Deny only: end the turn rather than returning a refusal the model can
       * plan around. Defaults to a plain refusal — a user saying "not this
       * tool" is not the same as "stop what you are doing".
       */
      interrupt?: boolean
    }
  ): Promise<void>
  setModel(model: string): Promise<void>
  /**
   * Accepts every mode `SendOptions.permissionMode` does. It used to accept
   * four of the six, so `dontAsk` and `auto` could be chosen when a session
   * started but never switched to afterwards — a restriction with no runtime
   * basis, since the sidecar forwards the string straight to the SDK.
   */
  setPermissionMode(mode: AgentPermissionMode): Promise<void>

  /**
   * Drive any allowlisted SDK `Query` control method on the live session,
   * capability-checked against the frozen spec first.
   *
   * One generic entry point rather than 23 near-identical wrappers: the
   * capability for each method comes from
   * {@link SESSION_CONTROL_CAPABILITIES}, so there is no place to write a
   * capability string by hand and get it wrong. The named methods below are
   * thin, typed conveniences over this — they exist for the return types, not
   * to add behaviour.
   *
   * `steer` is deliberately excluded: it must go through the PII-gated
   * `ipc.steerSession` wrapper, and offering a second unchecked path to it
   * here would quietly bypass that gate.
   */
  control<T = unknown>(
    method: Exclude<SessionControlMethod, "steer">,
    params?: Record<string, unknown>
  ): Promise<T>

  // ---- plugins & skills -----------------------------------------------------
  /** Reload plugins from disk; returns the refreshed commands/agents/servers. */
  reloadPlugins(): Promise<unknown>
  /** Reload skills from disk; returns the refreshed skill commands. */
  reloadSkills(): Promise<unknown>

  // ---- checkpointing --------------------------------------------------------
  /**
   * Rewind tracked files to their state at `userMessageId`.
   *
   * `dryRun` defaults to TRUE. The SDK's default is false, i.e. it writes; a
   * facade whose easiest call overwrites the user's working tree is the wrong
   * default for a UI, so the caller has to say `{ dryRun: false }` to actually
   * restore. Needs `enableFileCheckpointing` on the session — without it the
   * SDK returns `canRewind: false` rather than throwing.
   */
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>
  /** Read a file through the session's own read-permission rules. */
  readFile(
    path: string,
    options?: { maxBytes?: number; encoding?: "utf-8" | "base64" }
  ): Promise<unknown>
  /**
   * Tell the CLI a file was already read at `mtime`, so a following Edit does
   * not fail "file not read yet". Skipped CLI-side if the file changed since.
   */
  seedReadState(path: string, mtime: number): Promise<void>

  // ---- MCP ------------------------------------------------------------------
  /** Replace the dynamically-added MCP servers (plugin-owned ones are kept). */
  setMcpServers(servers: Record<string, unknown>): Promise<unknown>
  /** Pin or clear a per-server permission-mode override. Tighten-only. */
  setMcpPermissionModeOverride(
    serverName: string,
    mode: "default" | "auto" | null
  ): Promise<{ warning?: string }>

  // ---- subagents & tasks ----------------------------------------------------
  /** Subagents available to this session. */
  supportedAgents(): Promise<unknown[]>
  /** Stop a running task; a `task_notification` with status `stopped` follows. */
  stopTask(taskId: string): Promise<void>
  /**
   * Background in-flight foreground tasks. With `toolUseId`, only that one.
   * Resolves false only when a `toolUseId` matched no foreground task.
   */
  backgroundTasks(toolUseId?: string): Promise<boolean>

  // ---- session ---------------------------------------------------------------
  /** Cached first-connect initialization response. */
  initializationResult(): Promise<unknown>
  /** Force a FRESH initialize round-trip (use after a transport gap). */
  reinitialize(): Promise<unknown>
  /** Authenticated account info (email, organization, subscription). */
  accountInfo(): Promise<unknown>
  /** Shallow-merge settings into the mid-session flag layer. */
  applyFlagSettings(settings: Record<string, unknown>): Promise<void>
}

interface HandleDeps {
  ipc: Pick<
    typeof ipc,
    | "interruptSession"
    | "compactSession"
    | "setSessionMode"
    | "setSessionModel"
    | "subscribeAgentEvents"
    | "sessionControl"
  > & {
    resolvePermission: (
      sessionId: string,
      requestId: string,
      decision: string,
      message?: string,
      updatedInput?: Record<string, unknown>,
      interrupt?: boolean
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
      // Canonical `agent_interrupt`, not the deprecated `claude_interrupt`
      // alias `ipc.interruptSession` calls. Two reasons: the alias bumps the
      // Phase-9 retirement counter on every handle interrupt, making a fully
      // migrated caller look like legacy traffic; and only the `agent_*`
      // commands declare `command_id`, so the alias could never be deduped.
      interruptSession:
        deps?.ipc?.interruptSession ??
        (async (sid) => {
          const { transport } = await import("@/lib/tauri")
          await transport.call("agent_interrupt", {
            sessionId: sid,
            commandId: nextCommandId(),
          })
        }),
      compactSession:
        deps?.ipc?.compactSession ??
        (async (sid, focus) => {
          const { transport } = await import("@/lib/tauri")
          await transport.call("agent_compact", {
            sessionId: sid,
            focus,
            commandId: nextCommandId(),
          })
        }),
      setSessionMode: deps?.ipc?.setSessionMode ?? ipc.setSessionMode,
      setSessionModel: deps?.ipc?.setSessionModel ?? ipc.setSessionModel,
      subscribeAgentEvents: deps?.ipc?.subscribeAgentEvents ?? ipc.subscribeAgentEvents,
      sessionControl: deps?.ipc?.sessionControl ?? ipc.sessionControl,
      resolvePermission:
        deps?.ipc?.resolvePermission ??
        (async (sid, requestId, decision, message, updatedInput, interrupt) => {
          const { transport } = await import("@/lib/tauri")
          await transport.call("agent_resolve_permission", {
            sessionId: sid,
            requestId,
            decision,
            message,
            updatedInput,
            interrupt,
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
        options?.updatedInput,
        options?.interrupt
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

    async control(method, params) {
      requireCapability(spec, SESSION_CONTROL_CAPABILITIES[method], method)
      return io.ipc.sessionControl(sessionId, method, params)
    },

    reloadPlugins() {
      return this.control("reloadPlugins")
    },
    reloadSkills() {
      return this.control("reloadSkills")
    },

    rewindFiles(userMessageId, options) {
      // Default to a preview. See the interface docblock: the SDK writes by
      // default, and a facade whose easiest call rewrites the working tree is
      // the wrong shape for a UI.
      return this.control("rewindFiles", {
        userMessageId,
        options: { dryRun: options?.dryRun ?? true },
      })
    },
    readFile(path, options) {
      return this.control("readFile", { path, ...(options ? { options } : {}) })
    },
    async seedReadState(path, mtime) {
      await this.control("seedReadState", { path, mtime })
    },

    setMcpServers(servers) {
      return this.control("setMcpServers", { servers })
    },
    setMcpPermissionModeOverride(serverName, mode) {
      return this.control<{ warning?: string }>("setMcpPermissionModeOverride", {
        serverName,
        mode,
      })
    },

    supportedAgents() {
      return this.control<unknown[]>("supportedAgents")
    },
    async stopTask(taskId) {
      await this.control("stopTask", { taskId })
    },
    backgroundTasks(toolUseId) {
      return this.control<boolean>("backgroundTasks", toolUseId ? { toolUseId } : undefined)
    },

    initializationResult() {
      return this.control("initializationResult")
    },
    reinitialize() {
      return this.control("reinitialize")
    },
    accountInfo() {
      return this.control("accountInfo")
    },
    async applyFlagSettings(settings) {
      await this.control("applyFlagSettings", { settings })
    },
  }
}
