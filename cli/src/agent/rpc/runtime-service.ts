import { randomUUID } from "node:crypto"

import type {
  AgentPermissionMode,
  McpServer,
  PermissionRequestEvent,
  SandboxResourcePolicy,
} from "@cognia/agent-config-types"
import type {
  AgentEventEnvelope,
  ResolvedAgentExecutionSpec,
} from "@cognia/agent-config-types/agent-execution"
import type { AgentRunResultV1 } from "@cognia/agent-config-types/agent-run-result"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import type { PluginTool } from "@/types/plugin"
import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"
import {
  ASK_USER_TOOL_NAME,
  formatAskUserAnswer,
  parseAskUserArgs,
} from "@/lib/claude/ask-user-tool"

import { catalogModelIds } from "@/lib/ai/model-options"
import { validateMcpDefinition } from "@/lib/mcp/server-definition"
import {
  clearActiveSandboxPolicy,
  getActiveSandboxPolicy,
  setActiveSandboxPolicy,
} from "@/lib/sandbox/policy-bridge"
import {
  compactSession,
  onClaudeMessage,
  restoreSession,
  sessionControl,
  setSessionMode,
  setSessionModel,
  steerSession,
} from "@/lib/claude/ipc"

import type { ResolvedConfig } from "../../config/schema"
import type { PermissionResponder } from "../permission-gate"
import { mintSessionId as defaultMintSessionId } from "../run"
import { createSessionStore, type SessionStore, type StoreResult } from "../session-store/store"
import { createProviderSessionLease, type ProviderSessionLease } from "../runtime/provider-session"
import { resolveWorkerExecutionProfile } from "../runtime/resolve-worker-execution"
import { runUnifiedTurn, type UnifiedTurnParams } from "../runtime/unified-runtime"
import { subscribePluginToolDispatch } from "../../plugin/plugin-tool-dispatch"
import { makeCliPluginToolHandle } from "../subagent-dispatch"
import type { AgentRpcService, AgentRpcServiceContext } from "./server"
import { AgentRpcHostError } from "./server"
import {
  createDurableRpcStateStore,
  type DurableRpcStateStore,
  type DurableRpcSuspendedTurn,
} from "./durable-state"
import {
  RPC_ERROR_CODES,
  type HostRequestMethodMap,
  type RpcMethod,
  type RpcMethodMap,
} from "@/packages/agent/src/protocol"
import type { HandoffEnvelope } from "@/packages/agent/src/handoff-envelope"
import type { AgentWorkerManifestV1 } from "@/packages/agent/src/types"
import { createRpcAuditStore, type RpcAuditEntry } from "./observability"

const SUPPORTED_METHODS = [
  "runtime/status",
  "runtime/capabilities",
  "model/list",
  "model/refresh",
  "auth/status",
  "session/create",
  "session/open",
  "session/list",
  "session/state",
  "session/messages",
  "session/entries",
  "session/rename",
  "session/tag",
  "session/delete",
  "session/export",
  "session/import",
  "session/fork",
  "session/clone",
  "session/tree",
  "session/close",
  "turn/run",
  "turn/steer",
  "turn/followUp",
  "turn/abort",
  "turn/wait",
  "session/model/set",
  "session/thinking/set",
  "session/permissionMode/set",
  "session/compact",
  "session/compact/undo",
  "permission/respond",
  "elicitation/respond",
  "externalTool/respond",
  "tool/register",
  "tool/unregister",
  "hook/register",
  "hook/unregister",
  "mcp/configure",
  "mcp/status",
  "plugin/reload",
  "skill/reload",
  "task/list",
  "task/stop",
  "task/background",
  "sandbox/status",
  "sandbox/snapshot",
  "sandbox/restore",
  "trace/subscribe",
  "trace/export",
  "audit/query",
] as const satisfies readonly RpcMethod[]

const SERVICE_CAPABILITIES = [
  "canonical-sessions",
  "event-replay",
  "command-deduplication",
  "concurrent-sessions",
  "durable-provider-session",
  "permissions",
  "client-tools",
  "client-hooks",
  "mcp",
  "plugins",
  "skills",
  "tasks",
  "sandbox-policy-snapshots",
  "redacted-traces",
  "durable-audit",
  "live-compaction-undo",
] as const

interface CompactionSnapshot {
  sessionId: string
  messages: unknown[]
}

const CLIENT_CALLBACK_PII_ERROR = "client callback output blocked by the PII redaction gate"

interface PendingPermission {
  request: PermissionRequestEvent
  resolve: (decision: { decision: "allow" | "deny"; message?: string }) => void
}

interface PendingElicitation {
  request: Record<string, unknown>
  resolve: (response: PluginToolExecResponse) => void
}

interface HostedSession {
  id: string
  config: ResolvedConfig
  spec: ResolvedAgentExecutionSpec
  lease: ProviderSessionLease
  busy: boolean
  status: "idle" | "running" | "waiting" | "recovery_required" | "closed"
  abortController: AbortController | null
  activeRun: Promise<unknown> | null
  pendingPermissions: Map<string, PendingPermission>
  pendingElicitations: Map<string, PendingElicitation>
  consumedExternalToolResponses: Set<string>
  commandResults: Map<string, Promise<unknown>>
  followUps: Array<{ input: string; context: AgentRpcServiceContext }>
  currentRunId: string | null
  currentAttemptId: string | null
  durableState: DurableRpcStateStore
  workerHandoff?: HandoffEnvelope
}

export interface AgentRuntimeServiceOptions {
  config: ResolvedConfig
  home: string
  sessionDirOverride?: string
  store?: SessionStore
  runTurn?: typeof runUnifiedTurn
  createLease?: () => ProviderSessionLease
  mintSessionId?: (now?: number, random?: number) => string
  now?: () => number
  random?: () => number
  subscribePluginTools?: (
    handler: (request: PluginToolExecRequest) => Promise<PluginToolExecResponse>
  ) => Promise<() => void>
  subscribeCompactionEvents?: (handler: (payload: unknown) => void) => Promise<() => void>
  compact?: typeof compactSession
  restore?: typeof restoreSession
  compactionTimeoutMs?: number
  workerDispatch?: {
    manifest: AgentWorkerManifestV1
    validateHandoffExecution?(handoff: HandoffEnvelope): void
    resolveHandoffWorkspace(handoff: HandoffEnvelope, commandId: string): string | Promise<string>
  }
}

export function createAgentRuntimeService(options: AgentRuntimeServiceOptions): AgentRpcService {
  const store =
    options.store ??
    createSessionStore({
      home: options.home,
      ...(options.sessionDirOverride ? { sessionDirOverride: options.sessionDirOverride } : {}),
    })
  const runTurn = options.runTurn ?? runUnifiedTurn
  const createLease = options.createLease ?? createProviderSessionLease
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const sessions = new Map<string, HostedSession>()
  const durableState = createDurableRpcStateStore((sessionId) => store.paths(sessionId).dir)
  const auditStore = createRpcAuditStore(options.home)
  const registeredTools = new Map<string, { pluginId: string; toolName: string }>()
  const registeredHooks = new Map<string, { pluginId: string }>()
  const deletedCommands = new Map<string, Record<string, unknown>>()
  const createCommands = new Map<string, Promise<Record<string, unknown>>>()
  const traceSubscriptions = new Map<
    string,
    { sessionId?: string; context: AgentRpcServiceContext }
  >()
  const compactionSnapshots = new Map<string, CompactionSnapshot>()
  let configuredMcpServers: McpServer[] | null = null
  let closing = false
  const serviceCapabilities = options.workerDispatch
    ? [...SERVICE_CAPABILITIES, "worker-dispatch-v1"]
    : SERVICE_CAPABILITIES

  function readEntries(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = requireString(params, "sessionId")
    const envelopes = store.readEnvelopes(sessionId)
    const afterEventId = typeof params.afterEventId === "string" ? params.afterEventId : undefined
    const requestedLimit = typeof params.limit === "number" ? params.limit : 10_000
    const limit = Math.min(10_000, Math.max(1, requestedLimit))
    const cursorIndex = afterEventId
      ? envelopes.findIndex((envelope) => envelope.eventId === afterEventId)
      : -1
    if (afterEventId && cursorIndex === -1) {
      throw structured("usage_error", `unknown event cursor ${afterEventId}`)
    }
    const page = envelopes.slice(cursorIndex + 1, cursorIndex + 1 + limit)
    const hasMore = cursorIndex + 1 + page.length < envelopes.length
    return {
      entries: page.map((envelope) => ({ envelope })),
      ...(hasMore && page.length > 0 ? { nextEventId: page.at(-1)!.eventId } : {}),
    }
  }

  function resolveSessionExecutionSpec(
    config: ResolvedConfig,
    identity?: Partial<ResolvedAgentExecutionSpec["identity"]>
  ): ResolvedAgentExecutionSpec {
    return resolveWorkerExecutionProfile(config, identity).spec
  }

  function materialize(sessionId: string, config = options.config): HostedSession {
    const existing = sessions.get(sessionId)
    if (existing) return existing
    const opened = store.open(sessionId, { writable: false, allowForeignWorkspace: true })
    if (!opened.ok) throw structured(opened.error.code, opened.error.message, opened.error)
    const runtimeConfig: ResolvedConfig = {
      ...config,
      cwd: opened.value.manifest.workspace || config.cwd,
      ...(opened.value.manifest.runtimeBinding?.backend
        ? { agentBackend: opened.value.manifest.runtimeBinding.backend }
        : {}),
      ...(opened.value.manifest.runtimeBinding?.model
        ? { model: opened.value.manifest.runtimeBinding.model }
        : {}),
    }
    opened.value.close()
    const persisted = durableState.read(sessionId)
    const unresolvedCount =
      Object.keys(persisted.pendingPermissions).length +
      Object.keys(persisted.pendingElicitations).length +
      Object.keys(persisted.pendingExternalTools).length
    const needsRecovery = unresolvedCount > 0 || persisted.suspendedTurn !== null
    if (needsRecovery && !persisted.recoveryRequired) {
      durableState.update(sessionId, (state) => {
        state.recoveryRequired = true
      })
    }
    const session: HostedSession = {
      id: sessionId,
      config: runtimeConfig,
      spec: resolveSessionExecutionSpec(runtimeConfig, { sessionId, runId: sessionId }),
      lease: createLease(),
      busy: false,
      status: needsRecovery ? "recovery_required" : "idle",
      abortController: null,
      activeRun: null,
      pendingPermissions: new Map(),
      pendingElicitations: new Map(),
      consumedExternalToolResponses: new Set(),
      commandResults: new Map(
        Object.entries(persisted.commandResults).map(([key, value]) => [
          key,
          Promise.resolve(value),
        ])
      ),
      followUps: [],
      currentRunId: null,
      currentAttemptId: null,
      durableState,
    }
    if (persisted.sandboxPolicy) {
      setActiveSandboxPolicy(sessionId, persisted.sandboxPolicy as SandboxResourcePolicy)
    }
    sessions.set(sessionId, session)
    return session
  }

  async function dispatch(
    method: RpcMethod,
    typedParams: RpcMethodMap[RpcMethod]["params"],
    context: AgentRpcServiceContext
  ): Promise<unknown> {
    if (closing) throw new AgentRpcHostError(-1, "runtime is shutting down")
    const params = typedParams as Record<string, unknown>

    switch (method) {
      case "runtime/status":
        return result({
          status: "ready",
          openSessions: sessions.size,
          activeTurns: countActiveTurns(),
          ...(options.workerDispatch ? { workerManifest: options.workerDispatch.manifest } : {}),
        })
      case "runtime/capabilities":
        return result({ methods: SUPPORTED_METHODS, capabilities: serviceCapabilities })
      case "model/list":
      case "model/refresh":
        return result({
          models: catalogModelIds(options.config.provider).map((id) => ({
            id,
            provider: options.config.provider,
          })),
        })
      case "auth/status":
        return result({
          provider: options.config.provider,
          configured: Boolean(options.config.providers[options.config.provider]?.apiKey),
        })
      case "session/create":
        return result(await createSession(params))
      case "session/open": {
        const session = materialize(requireString(params, "sessionId"))
        return result({ sessionId: session.id, spec: session.spec })
      }
      case "session/list":
        return result({ sessions: store.list() })
      case "session/state":
        return result(readState(materialize(requireString(params, "sessionId"))))
      case "session/messages": {
        const canonical = requireStore(store.toCanonicalSession(requireString(params, "sessionId")))
        return result({ messages: canonical.turns })
      }
      case "session/entries":
        return result(readEntries(params))
      case "session/rename": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const opened = requireStore(
              store.open(session.id, { writable: true, allowForeignWorkspace: true })
            )
            try {
              opened.setName(requireString(params, "name"))
            } finally {
              opened.close()
            }
            return receipt(commandId)
          })
        )
      }
      case "session/tag": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const tags = [...new Set((params.tags as string[]).map((tag) => tag.trim()))]
            session.durableState.update(session.id, (state) => {
              state.tags = tags
            })
            return { ...receipt(commandId), tags }
          })
        )
      }
      case "session/export":
        return result(requireStore(store.toCanonicalSession(requireString(params, "sessionId"))))
      case "session/import": {
        const canonical = params.session as Parameters<SessionStore["importCanonical"]>[0]
        const requestedId = canonical?.header?.canonicalSessionId
        const sessionId =
          typeof requestedId === "string" &&
          !store.list().some((entry) => entry.sessionId === requestedId)
            ? requestedId
            : uniqueSessionId()
        const importSpec = resolveSessionExecutionSpec(options.config)
        const imported = requireStore(
          store.importCanonical(canonical, sessionId, {
            cwd: options.config.cwd,
            runtimeBinding: {
              backend: options.config.agentBackend ?? "builtin",
              model: importSpec.modelBindings.primary,
              provider: options.config.provider,
            },
          })
        )
        imported.close()
        const session = materialize(sessionId)
        return result({ sessionId: session.id, spec: session.spec })
      }
      case "session/fork":
      case "session/clone": {
        const source = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(source, method, params, async (commandId) => {
            const newId = uniqueBranchId(source.id, method === "session/fork" ? "fork" : "clone")
            const branch = requireStore(
              store.branch(
                source.id,
                newId,
                method === "session/fork" ? "fork" : "clone",
                typeof params.turnId === "string" ? params.turnId : undefined,
                {
                  cwd: source.config.cwd,
                  ...(typeof params.name === "string" ? { name: params.name } : {}),
                }
              )
            )
            branch.close()
            const created = materialize(newId, source.config)
            return { sessionId: created.id, spec: created.spec, commandId }
          })
        )
      }
      case "session/tree":
        return result({ roots: store.tree() })
      case "session/close": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            await closeSession(session)
            return receipt(commandId)
          })
        )
      }
      case "session/delete": {
        const sessionId = requireString(params, "sessionId")
        const commandId = commandIdFrom(params)
        const key = `${sessionId}:${commandId}`
        const duplicate = deletedCommands.get(key)
        if (duplicate) return result(duplicate)
        const live = sessions.get(sessionId)
        if (live) await closeSession(live)
        requireStore(store.delete(sessionId))
        const deleted = { ...receipt(commandId), deleted: true }
        deletedCommands.set(key, deleted)
        if (deletedCommands.size > 1_000)
          deletedCommands.delete(deletedCommands.keys().next().value!)
        return result(deleted)
      }
      case "turn/run": {
        const session = materialize(requireString(params, "sessionId"))
        if (session.status === "recovery_required") {
          throw structured(
            "recovery_required",
            "settle or reject every recovered pending action before starting another turn"
          )
        }
        const commandId = commandIdFrom(params)
        return result(
          await runCommand(session, method, params, () =>
            runSession(session, lowerInput(params.input), params, context, commandId)
          )
        )
      }
      case "turn/steer": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            if (!session.busy) throw structured("usage_error", "no active turn to steer")
            await steerSession(session.id, lowerInput(params.input), undefined, {
              priority: "now",
              commandId,
            })
            return receipt(commandId)
          })
        )
      }
      case "turn/followUp": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            session.followUps.push({ input: lowerInput(params.input), context })
            if (!session.busy) void drainFollowUps(session)
            return receipt(commandId)
          })
        )
      }
      case "turn/abort": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            session.abortController?.abort("rpc abort")
            denyPending(session, "turn aborted")
            return receipt(commandId)
          })
        )
      }
      case "turn/wait": {
        const session = materialize(requireString(params, "sessionId"))
        if (session.activeRun) await waitWithDeadline(session.activeRun, params.timeoutMs)
        return result(readState(session))
      }
      case "session/model/set": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const model = requireString(params, "model")
            session.config.model = model
            session.spec = resolveSessionExecutionSpec(session.config, session.spec.identity)
            if (session.lease.current?.isLive?.()) {
              const applied = await session.lease.current.setModel?.(model)
              if (applied === false) await setSessionModel(session.id, model, { commandId })
            }
            return receipt(commandId)
          })
        )
      }
      case "session/thinking/set": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            session.config.thinkingLevel = requireString(
              params,
              "level"
            ) as ResolvedConfig["thinkingLevel"]
            session.lease.current?.invalidateOptions?.()
            return receipt(commandId)
          })
        )
      }
      case "session/permissionMode/set": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const mode = requireString(params, "mode") as AgentPermissionMode
            session.config.permissionMode = mode
            if (session.lease.current) await session.lease.current.setPermissionMode?.(mode)
            else await setSessionMode(session.id, mode, { commandId }).catch(() => undefined)
            return receipt(commandId)
          })
        )
      }
      case "session/compact": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            if (!session.lease.current?.isLive?.()) {
              throw structured("unsupported_capability", "compaction requires a live session")
            }
            const boundary = await compactLiveSession(
              session.id,
              typeof params.instructions === "string" ? params.instructions : undefined,
              commandId
            )
            if (boundary?.messages) {
              compactionSnapshots.set(boundary.boundaryId, {
                sessionId: session.id,
                messages: boundary.messages,
              })
            }
            return {
              ...receipt(commandId),
              undoAvailable: Boolean(boundary?.messages),
              ...(boundary?.messages ? { boundaryId: boundary.boundaryId } : {}),
            }
          })
        )
      }
      case "session/compact/undo": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            if (!session.lease.current?.isLive?.()) {
              throw structured("unsupported_capability", "compaction undo requires a live session")
            }
            if (session.busy) {
              throw structured("session_busy", "compaction undo requires an idle session")
            }
            const boundaryId = requireString(params, "boundaryId")
            const snapshot = compactionSnapshots.get(boundaryId)
            if (!snapshot || snapshot.sessionId !== session.id) {
              throw structured(
                "unsupported_capability",
                "the compaction snapshot is unavailable or belongs to another host session"
              )
            }
            await (options.restore ?? restoreSession)(session.id, snapshot.messages)
            compactionSnapshots.delete(boundaryId)
            return receipt(commandId)
          })
        )
      }
      case "permission/respond": {
        const session = materialize(requireString(params, "sessionId"))
        const response = await runCommand(session, method, params, async (commandId) => {
          const requestId = requireString(params, "requestId")
          const pending = session.pendingPermissions.get(requestId)
          const durable = session.durableState.read(session.id)
          const persisted = durable.pendingPermissions[requestId]
          if (!pending && !persisted) {
            throw structured("usage_error", `unknown permission request ${requestId}`)
          }
          if (!pending && !durable.suspendedTurn) {
            throw structured(
              "recovery_required",
              `permission request ${requestId} has no suspended turn to resume`
            )
          }
          session.pendingPermissions.delete(requestId)
          const decision = params.decision as Record<string, unknown>
          session.durableState.update(session.id, (state) => {
            delete state.pendingPermissions[requestId]
            if (!pending && state.suspendedTurn) {
              state.suspendedTurn.permissionResponses[requestId] = {
                decision,
                request: persisted,
              }
            }
            state.recoveryRequired = hasPendingActions(state)
          })
          const kind = decision.kind
          pending?.resolve(
            kind === "approve" || kind === "approve_always"
              ? { decision: "allow" }
              : {
                  decision: "deny",
                  ...(typeof decision.reason === "string" ? { message: decision.reason } : {}),
                }
          )
          session.status = pending ? "running" : nextRecoveryStatus(session)
          return {
            ...receipt(commandId),
            recovered: !pending,
            ...(!pending ? { resumeScheduled: true } : {}),
          }
        })
        if (response.resumeScheduled === true) void resumeSuspendedTurn(session, context)
        return result(response)
      }
      case "elicitation/respond": {
        const session = materialize(requireString(params, "sessionId"))
        const settlement = await runCommand(session, method, params, async (commandId) => {
          const requestId = requireString(params, "requestId")
          const pending = session.pendingElicitations.get(requestId)
          const durable = session.durableState.read(session.id)
          const persisted = durable.pendingElicitations[requestId]
          if (!pending && !persisted) {
            throw structured("usage_error", `unknown elicitation request ${requestId}`)
          }
          if (!pending && !durable.suspendedTurn) {
            throw structured(
              "recovery_required",
              `elicitation request ${requestId} has no suspended turn to resume`
            )
          }
          const response = params.response as Record<string, unknown>
          session.pendingElicitations.delete(requestId)
          session.durableState.update(session.id, (state) => {
            delete state.pendingElicitations[requestId]
            if (!pending && state.suspendedTurn) {
              state.suspendedTurn.elicitationResponses[requestId] = {
                response,
                request: persisted,
              }
            }
            state.recoveryRequired = hasPendingActions(state)
          })
          if (pending) {
            const request = parseAskUserArgs(
              (pending.request.args as Record<string, unknown> | undefined) ?? {}
            )
            const kind = response.kind
            const rawValue = response.value
            const answer =
              kind === "submit" && rawValue && typeof rawValue === "object"
                ? (rawValue as { selected?: unknown; text?: unknown; cancelled?: unknown })
                : {}
            pending.resolve({
              type: "plugin_tool_response",
              sessionId: session.id,
              toolUseId: requestId,
              result: formatAskUserAnswer(request, {
                selected: Array.isArray(answer.selected)
                  ? answer.selected.filter((item): item is string => typeof item === "string")
                  : [],
                text: typeof answer.text === "string" ? answer.text : "",
                cancelled: kind !== "submit" || answer.cancelled === true,
              }),
            })
            session.status = "running"
          } else {
            session.status = nextRecoveryStatus(session)
          }
          return {
            ...receipt(commandId),
            recovered: !pending,
            ...(!pending ? { resumeScheduled: true } : {}),
          }
        })
        if (settlement.resumeScheduled === true) void resumeSuspendedTurn(session, context)
        return result(settlement)
      }
      case "tool/register": {
        const handlerId = requireString(params, "handlerId")
        if (registeredTools.has(handlerId)) {
          throw structured("usage_error", `tool handler ${handlerId} is already registered`)
        }
        await ensureExtensibilityRuntime()
        const pluginId = `rpc-client-tool:${handlerId}`
        const toolName = requireString(params, "name")
        const sideEffect = requireString(params, "sideEffect")
        const tool: PluginTool = {
          name: toolName,
          pluginId,
          definition: {
            name: toolName,
            description: requireString(params, "description"),
            parametersSchema: params.inputSchema as Record<string, unknown>,
            requiresApproval: sideEffect !== "none",
            retryable: sideEffect === "idempotent",
          },
          execute: async (input, toolContext) => {
            const session =
              (toolContext.sessionId ? sessions.get(toolContext.sessionId) : undefined) ??
              requireSingleLiveSession(sessions)
            const toolCallId = toolContext.messageId ?? randomUUID()
            const idempotencyKey = `${session.id}:${toolName}:${toolCallId}`
            const recovered = findRecoveredResponseEntry(
              session.durableState.read(session.id).suspendedTurn?.externalToolResponses,
              toolCallId,
              (value) => {
                const original = value.request
                return (
                  isRecord(original) &&
                  original.handlerId === handlerId &&
                  original.toolName === toolName &&
                  JSON.stringify(original.input) === JSON.stringify(input)
                )
              },
              session.consumedExternalToolResponses
            )
            if (recovered && isRecord(recovered.value.response)) {
              session.consumedExternalToolResponses.add(recovered.requestId)
              return externalToolResponseOutput(recovered.value.response)
            }
            session.durableState.update(session.id, (state) => {
              state.pendingExternalTools[toolCallId] = {
                requestId: toolCallId,
                handlerId,
                toolName,
                sideEffect,
                idempotencyKey,
                input,
              }
            })
            let callback: HostRequestMethodMap["client/tool/invoke"]["result"]
            try {
              callback = await context.requestClient(
                "client/tool/invoke",
                {
                  handlerId,
                  toolCallId,
                  sessionId: session.id,
                  runId: session.currentRunId ?? `run-${toolCallId}`,
                  attemptId: session.currentAttemptId ?? `attempt-${toolCallId}`,
                  idempotencyKey,
                  input,
                },
                {
                  ...(typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : {}),
                  signal: toolContext.signal,
                }
              )
            } catch (error) {
              session.status = "recovery_required"
              session.durableState.update(session.id, (state) => {
                state.recoveryRequired = true
              })
              throw error
            }
            session.durableState.update(session.id, (state) => {
              delete state.pendingExternalTools[toolCallId]
            })
            if (!callback.ok) {
              const safeError = hasNoLeakingPiiDeep(callback.error)
                ? callback.error
                : { message: CLIENT_CALLBACK_PII_ERROR }
              throw structured(
                "tool_error",
                String(
                  (safeError as Record<string, unknown> | undefined)?.message ??
                    "client tool failed"
                ),
                safeError
              )
            }
            if (!hasNoLeakingPiiDeep(callback.output)) {
              throw structured("permission_denied", CLIENT_CALLBACK_PII_ERROR)
            }
            return callback.output
          },
        }
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        const { usePluginStore } = await import("@/stores/plugin-runtime")
        getPluginManager().getRegistry().registerTool(pluginId, tool)
        usePluginStore.getState().registerPluginTool(pluginId, tool)
        registeredTools.set(handlerId, { pluginId, toolName })
        invalidateSessionOptions(sessions)
        return result({ ok: true })
      }
      case "externalTool/respond": {
        const session = materialize(requireString(params, "sessionId"))
        const settlement = await runCommand(session, method, params, async (commandId) => {
          const requestId = requireString(params, "requestId")
          const durable = session.durableState.read(session.id)
          const pending = durable.pendingExternalTools[requestId]
          if (!pending)
            throw structured("usage_error", `unknown external tool request ${requestId}`)
          if (!durable.suspendedTurn) {
            throw structured(
              "recovery_required",
              `external tool request ${requestId} has no suspended turn to resume`
            )
          }
          const response = normalizeExternalToolResponse(params.response)
          session.durableState.update(session.id, (state) => {
            delete state.pendingExternalTools[requestId]
            if (state.suspendedTurn) {
              state.suspendedTurn.externalToolResponses[requestId] = {
                request: pending,
                response,
              }
            }
            state.recoveryRequired = hasPendingActions(state)
          })
          session.status = nextRecoveryStatus(session)
          return {
            ...receipt(commandId),
            recovered: true,
            resumeScheduled: true,
            requestId,
            response,
          }
        })
        if (settlement.resumeScheduled === true) void resumeSuspendedTurn(session, context)
        return result(settlement)
      }
      case "tool/unregister": {
        const handlerId = requireString(params, "handlerId")
        const registered = registeredTools.get(handlerId)
        if (registered) {
          const { getPluginManager } = await import("@/lib/plugin/core/manager")
          const { usePluginStore } = await import("@/stores/plugin-runtime")
          getPluginManager().getRegistry().unregisterTool(registered.toolName)
          usePluginStore.getState().unregisterPluginTool(registered.pluginId, registered.toolName)
          registeredTools.delete(handlerId)
          invalidateSessionOptions(sessions)
        }
        return result({ ok: true })
      }
      case "hook/register": {
        const handlerId = requireString(params, "handlerId")
        if (registeredHooks.has(handlerId)) {
          throw structured("usage_error", `hook handler ${handlerId} is already registered`)
        }
        await ensureExtensibilityRuntime()
        const pluginId = `rpc-client-hook:${handlerId}`
        const event = requireString(params, "event")
        const timeoutPolicy = requireString(params, "timeoutPolicy")
        const callback = async (...args: unknown[]) => {
          const session = [...sessions.values()].find((candidate) => candidate.busy)
          const invocationId = randomUUID()
          try {
            const response = await context.requestClient(
              "client/hook/invoke",
              {
                handlerId,
                invocationId,
                sessionId: session?.id ?? "runtime",
                runId: session?.currentRunId ?? `run-${invocationId}`,
                attemptId: session?.currentAttemptId ?? `attempt-${invocationId}`,
                payload: { event, args },
              },
              typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : undefined
            )
            if (!response.ok) throw new Error("client hook rejected")
            if (!hasNoLeakingPiiDeep(response.output)) {
              throw structured("permission_denied", CLIENT_CALLBACK_PII_ERROR)
            }
            return response.output
          } catch (error) {
            if (timeoutPolicy === "continue") return undefined
            if (timeoutPolicy === "deny") return false
            throw error
          }
        }
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        getPluginManager()
          .getHooksManager()
          .registerHooks(pluginId, { [event]: callback } as never)
        registeredHooks.set(handlerId, { pluginId })
        return result({ ok: true })
      }
      case "hook/unregister": {
        const handlerId = requireString(params, "handlerId")
        const registered = registeredHooks.get(handlerId)
        if (registered) {
          const { getPluginManager } = await import("@/lib/plugin/core/manager")
          getPluginManager().getHooksManager().unregisterHooks(registered.pluginId)
          registeredHooks.delete(handlerId)
        }
        return result({ ok: true })
      }
      case "mcp/configure": {
        try {
          if (!Array.isArray(params.servers)) throw new Error("servers must be an array")
          configuredMcpServers = params.servers.map((server: unknown) =>
            validateMcpDefinition(server as McpServer)
          )
        } catch (error) {
          throw structured(
            "usage_error",
            error instanceof Error ? error.message : "invalid MCP server configuration"
          )
        }
        const applied: Record<string, unknown> = {}
        for (const session of sessions.values()) {
          session.lease.current?.invalidateOptions?.()
          if (session.lease.current?.isLive?.()) {
            applied[session.id] = await sessionControl(session.id, "setMcpServers", {
              servers: configuredMcpServers,
            })
          }
        }
        return result({ configured: configuredMcpServers.length, applied })
      }
      case "mcp/status": {
        const liveStatuses: Record<string, unknown> = {}
        for (const session of sessions.values()) {
          if (session.lease.current?.isLive?.()) {
            liveStatuses[session.id] = await sessionControl(session.id, "mcpServerStatus")
          }
        }
        return result({ configured: configuredMcpServers ?? [], live: liveStatuses })
      }
      case "plugin/reload": {
        if (typeof params.pluginId === "string") {
          throw structured(
            "unsupported_capability",
            "targeted plugin reload is unavailable; omit pluginId to reload the live session"
          )
        }
        const live = requireSingleLiveSession(sessions)
        return result(await sessionControl(live.id, "reloadPlugins"))
      }
      case "skill/reload": {
        if (typeof params.skillId === "string") {
          throw structured(
            "unsupported_capability",
            "targeted skill reload is unavailable; omit skillId to reload the live session"
          )
        }
        const live = requireSingleLiveSession(sessions)
        return result(await sessionControl(live.id, "reloadSkills"))
      }
      case "task/list": {
        const live = requireSingleLiveSession(sessions, params.sessionId)
        return result({ tasks: await sessionControl(live.id, "supportedAgents") })
      }
      case "task/stop": {
        const live = requireSingleLiveSession(sessions)
        await sessionControl(live.id, "stopTask", { taskId: requireString(params, "taskId") })
        return result(receipt(commandIdFrom(params)))
      }
      case "task/background": {
        const live = requireSingleLiveSession(sessions)
        const accepted = await sessionControl<boolean>(live.id, "backgroundTasks", {
          toolUseId: requireString(params, "taskId"),
        })
        return result({ ...receipt(commandIdFrom(params)), accepted })
      }
      case "sandbox/status": {
        const session = materialize(requireString(params, "sessionId"))
        const persisted = session.durableState.read(session.id)
        const policy =
          getActiveSandboxPolicy(session.id) ??
          (persisted.sandboxPolicy as SandboxResourcePolicy | null)
        return result({
          enabled: policy !== null,
          policy,
          workspace: session.config.cwd,
          snapshotCount: Object.keys(persisted.sandboxSnapshots).length,
        })
      }
      case "sandbox/snapshot": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const snapshotId = `sandbox-${randomUUID()}`
            const createdAt = new Date(now()).toISOString()
            const active = getActiveSandboxPolicy(session.id)
            session.durableState.update(session.id, (state) => {
              state.sandboxPolicy = active ? { ...active } : state.sandboxPolicy
              state.sandboxSnapshots[snapshotId] = {
                snapshotId,
                createdAt,
                policy: active ? { ...active } : state.sandboxPolicy,
              }
            })
            return { snapshotId, createdAt, commandId }
          })
        )
      }
      case "sandbox/restore": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const snapshotId = requireString(params, "snapshotId")
            const snapshot = session.durableState.read(session.id).sandboxSnapshots[snapshotId]
            if (!snapshot) throw structured("usage_error", `unknown sandbox snapshot ${snapshotId}`)
            session.durableState.update(session.id, (state) => {
              state.sandboxPolicy = snapshot.policy ? { ...snapshot.policy } : null
            })
            setActiveSandboxPolicy(session.id, snapshot.policy as SandboxResourcePolicy | null)
            session.lease.current?.invalidateOptions?.()
            return { ...receipt(commandId), snapshotId }
          })
        )
      }
      case "trace/subscribe": {
        const subscriptionId = randomUUID()
        traceSubscriptions.set(subscriptionId, {
          ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
          context,
        })
        return result({ subscriptionId, redacted: true })
      }
      case "trace/export": {
        const format = typeof params.format === "string" ? params.format : "json"
        if (format !== "json") {
          throw structured("unsupported_capability", `trace format ${format} is not supported`)
        }
        return result({
          format,
          redacted: true,
          ...auditStore.exportTrace(
            typeof params.sessionId === "string" ? params.sessionId : undefined
          ),
        })
      }
      case "audit/query":
        return result(
          auditStore.query({
            ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
            ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
            ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
          })
        )
      default:
        throw new AgentRpcHostError(
          RPC_ERROR_CODES.capabilityError,
          `method is not implemented by the runtime service: ${method}`
        )
    }
  }

  async function createSession(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const commandId = commandIdFrom(params)
    const commandKey = `session/create:${commandId}`
    const inFlight = createCommands.get(commandKey)
    if (inFlight) return inFlight
    const persisted = findPersistedCreateResult(commandKey)
    if (persisted) {
      const replay = Promise.resolve(persisted)
      createCommands.set(commandKey, replay)
      return replay
    }

    const pending = createSessionOnce(params, commandId, commandKey)
    createCommands.set(commandKey, pending)
    try {
      return await pending
    } catch (error) {
      createCommands.delete(commandKey)
      throw error
    }
  }

  async function createSessionOnce(
    params: Record<string, unknown>,
    commandId: string,
    commandKey: string
  ): Promise<Record<string, unknown>> {
    const handoff = params.handoff as HandoffEnvelope | undefined
    if (handoff && !options.workerDispatch) {
      throw structured("unsupported_capability", "host does not support worker-dispatch-v1")
    }
    if (handoff && typeof params.cwd === "string") {
      throw structured("usage_error", "remote handoff session creation does not accept cwd")
    }
    const base = options.config
    const handoffWorkspace = handoff
      ? await options.workerDispatch!.resolveHandoffWorkspace(handoff, commandId)
      : undefined
    const config: ResolvedConfig = {
      ...base,
      ...(handoffWorkspace
        ? { cwd: handoffWorkspace }
        : typeof params.cwd === "string"
          ? { cwd: params.cwd }
          : {}),
      ...(typeof params.model === "string" ? { model: params.model } : {}),
      ...(typeof params.permissionMode === "string"
        ? { permissionMode: params.permissionMode as ResolvedConfig["permissionMode"] }
        : {}),
    }
    const id = uniqueSessionId()
    const spec = resolveSessionExecutionSpec(config, { sessionId: id, runId: id })
    const created = requireStore(
      store.create(id, {
        cwd: config.cwd,
        ...(typeof params.name === "string" ? { name: params.name } : {}),
        runtimeBinding: {
          backend: config.agentBackend ?? "builtin",
          model: spec.modelBindings.primary,
          provider: config.provider,
        },
      })
    )
    created.close()
    const session: HostedSession = {
      id,
      config,
      spec,
      lease: createLease(),
      busy: false,
      status: "idle",
      abortController: null,
      activeRun: null,
      pendingPermissions: new Map(),
      pendingElicitations: new Map(),
      consumedExternalToolResponses: new Set(),
      commandResults: new Map(),
      followUps: [],
      currentRunId: null,
      currentAttemptId: null,
      durableState,
      ...(handoff ? { workerHandoff: handoff } : {}),
    }
    if (Array.isArray(params.tags) && params.tags.length > 0) {
      durableState.update(id, (state) => {
        state.tags = [...new Set((params.tags as string[]).map((tag) => tag.trim()))]
      })
    }
    sessions.set(id, session)
    const createdResult = { sessionId: id, spec, commandId }
    durableState.update(id, (state) => {
      state.commandResults[commandKey] = createdResult
    })
    return createdResult
  }

  function findPersistedCreateResult(commandKey: string): Record<string, unknown> | undefined {
    for (const summary of store.list()) {
      const value = durableState.read(summary.sessionId).commandResults[commandKey]
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).sessionId === "string"
      ) {
        return value as Record<string, unknown>
      }
    }
    return undefined
  }

  async function runSession(
    session: HostedSession,
    prompt: string,
    params: Record<string, unknown>,
    context: AgentRpcServiceContext,
    _commandId: string,
    recovery?: DurableRpcSuspendedTurn
  ): Promise<Record<string, unknown>> {
    if (session.busy) throw structured("session_busy", "a turn is already active")
    if (session.workerHandoff) {
      options.workerDispatch?.validateHandoffExecution?.(session.workerHandoff)
    }
    session.busy = true
    session.status = "running"
    session.consumedExternalToolResponses.clear()
    if (!recovery) {
      session.durableState.update(session.id, (state) => {
        state.suspendedTurn = {
          prompt,
          params: resumableTurnParams(params),
          attempt: 0,
          permissionResponses: {},
          elicitationResponses: {},
          externalToolResponses: {},
        }
        state.recoveryRequired = false
      })
    }
    const controller = new AbortController()
    session.abortController = controller
    const gate = createRpcPermissionGate(session, recovery)
    const turn = (async () => {
      try {
        const turnParams: UnifiedTurnParams = {
          config: session.config,
          prompt,
          gate,
          sessionId: session.id,
          persist: true,
          home: options.home,
          store,
          providerSession: session.lease,
          ...(recovery?.runId && recovery.turnId
            ? {
                recoveryIdentity: {
                  runId: recovery.runId,
                  turnId: recovery.turnId,
                  attempt: recovery.attempt + 1,
                },
              }
            : {}),
          signal: controller.signal,
          handleSignals: false,
          subscribePluginTools: () =>
            options.subscribePluginTools
              ? options.subscribePluginTools(createRpcPluginToolHandler(session, recovery))
              : subscribePluginToolDispatch({
                  handle: createRpcPluginToolHandler(session, recovery),
                }),
          ...(configuredMcpServers ? { resolveMcpServers: () => [...configuredMcpServers!] } : {}),
          onEnvelope: (envelope: AgentEventEnvelope) => {
            const attemptChanged = session.currentAttemptId !== envelope.attemptId
            session.currentRunId = envelope.runId
            session.currentAttemptId = envelope.attemptId
            if (attemptChanged) {
              session.durableState.update(session.id, (state) => {
                if (!state.suspendedTurn) return
                state.suspendedTurn.runId = envelope.runId
                state.suspendedTurn.turnId = envelope.turnId
                state.suspendedTurn.attempt = attemptIndex(envelope.attemptId)
              })
            }
            void context.emit("agent/event", { sessionId: session.id, envelope })
          },
          ...(options.sessionDirOverride ? { sessionDirOverride: options.sessionDirOverride } : {}),
          ...(typeof params.timeoutMs === "number" ? { timeoutMs: params.timeoutMs } : {}),
          ...(typeof params.idleTimeoutMs === "number"
            ? { idleTimeoutMs: params.idleTimeoutMs }
            : {}),
          ...(typeof params.maxSteps === "number" ? { maxSteps: params.maxSteps } : {}),
          ...(params.includeDiagnostics === true ? { includeDiagnostics: true } : {}),
        }
        const { result: runResult } = await runTurn(turnParams)
        session.durableState.update(session.id, (state) => {
          if (hasPendingRequests(state)) {
            state.recoveryRequired = true
            return
          }
          state.suspendedTurn = null
          state.recoveryRequired = false
        })
        return outcomeFrom(runResult)
      } finally {
        session.busy = false
        session.status =
          session.pendingPermissions.size > 0 || session.pendingElicitations.size > 0
            ? "waiting"
            : nextRecoveryStatus(session)
        session.abortController = null
        session.activeRun = null
        session.currentRunId = null
        session.currentAttemptId = null
        session.consumedExternalToolResponses.clear()
        if (session.followUps.length > 0) void drainFollowUps(session)
      }
    })()
    session.activeRun = turn
    return turn
  }

  function createRpcPermissionGate(
    session: HostedSession,
    recovery?: DurableRpcSuspendedTurn
  ): PermissionResponder {
    return async (request) => {
      const recovered = findRecoveredResponse(
        recovery?.permissionResponses,
        request.requestId,
        (value) => {
          const original = value.request
          return (
            isRecord(original) &&
            original.toolName === request.toolName &&
            JSON.stringify(original.input) === JSON.stringify(request.input)
          )
        }
      )
      if (recovered && isRecord(recovered.decision)) {
        return permissionDecision(recovered.decision)
      }
      session.status = "waiting"
      return new Promise((resolve) => {
        session.durableState.update(session.id, (state) => {
          state.pendingPermissions[request.requestId] = { ...request }
        })
        session.pendingPermissions.set(request.requestId, { request, resolve })
      })
    }
  }

  function createRpcPluginToolHandler(
    session: HostedSession,
    recovery?: DurableRpcSuspendedTurn
  ): (request: PluginToolExecRequest) => Promise<PluginToolExecResponse> {
    const fallback = makeCliPluginToolHandle()
    return async (request) => {
      if (request.name !== ASK_USER_TOOL_NAME) return fallback(request)
      session.status = "waiting"
      const parsed = parseAskUserArgs(request.args)
      const recovered = findRecoveredResponse(
        recovery?.elicitationResponses,
        request.toolUseId,
        (value) => {
          const original = value.request
          return (
            isRecord(original) && JSON.stringify(original.args) === JSON.stringify(request.args)
          )
        }
      )
      if (recovered && isRecord(recovered.response)) {
        return elicitationToolResponse(session.id, request.toolUseId, parsed, recovered.response)
      }
      const durableRequest = {
        requestId: request.toolUseId,
        source: ASK_USER_TOOL_NAME,
        prompt: parsed.question,
        schema: {
          type: "object",
          properties: {
            selected: { type: "array", items: { type: "string" } },
            text: { type: "string" },
          },
        },
        args: request.args,
      }
      session.durableState.update(session.id, (state) => {
        state.pendingElicitations[request.toolUseId] = durableRequest
      })
      return new Promise((resolve) => {
        session.pendingElicitations.set(request.toolUseId, {
          request: durableRequest,
          resolve,
        })
      })
    }
  }

  async function resumeSuspendedTurn(
    session: HostedSession,
    context: AgentRpcServiceContext
  ): Promise<void> {
    if (session.busy) return
    const recovery = session.durableState.read(session.id).suspendedTurn
    if (!recovery?.runId || !recovery.turnId) {
      session.status = "recovery_required"
      await context.emit("runtime/diagnostic", {
        level: "error",
        message: "suspended turn is missing its durable run identity",
      })
      return
    }
    try {
      await runSession(
        session,
        recovery.prompt,
        recovery.params,
        context,
        `recovery:${recovery.runId}:${recovery.turnId}`,
        recovery
      )
    } catch (error) {
      session.status = "recovery_required"
      session.durableState.update(session.id, (state) => {
        state.recoveryRequired = true
      })
      await context.emit("runtime/diagnostic", {
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function drainFollowUps(session: HostedSession): Promise<void> {
    if (session.busy) return
    const next = session.followUps.shift()
    if (!next) return
    try {
      await runSession(session, next.input, {}, next.context, randomUUID())
    } catch (error) {
      await next.context.emit("runtime/diagnostic", {
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function closeSession(session: HostedSession): Promise<void> {
    session.abortController?.abort("session closed")
    denyPending(session, "session closed")
    cancelPendingElicitations(session, "session closed")
    await session.activeRun?.catch(() => undefined)
    await session.lease.close()
    clearActiveSandboxPolicy(session.id)
    session.status = "closed"
    sessions.delete(session.id)
  }

  async function close(): Promise<void> {
    if (closing) return
    closing = true
    await Promise.all([...sessions.values()].map((session) => closeSession(session)))
    if (registeredTools.size > 0 || registeredHooks.size > 0) {
      try {
        const { getPluginManager } = await import("@/lib/plugin/core/manager")
        const { usePluginStore } = await import("@/stores/plugin-runtime")
        for (const registered of registeredTools.values()) {
          getPluginManager().getRegistry().unregisterTool(registered.toolName)
          usePluginStore.getState().unregisterPluginTool(registered.pluginId, registered.toolName)
        }
        for (const registered of registeredHooks.values()) {
          getPluginManager().getHooksManager().unregisterHooks(registered.pluginId)
        }
      } catch {
        // The plugin runtime may never have initialized.
      }
    }
    registeredTools.clear()
    registeredHooks.clear()
    traceSubscriptions.clear()
    compactionSnapshots.clear()
  }

  async function compactLiveSession(
    sessionId: string,
    instructions: string | undefined,
    commandId: string
  ): Promise<{ boundaryId: string; messages?: unknown[] } | null> {
    if (instructions !== undefined && !hasNoLeakingPiiDeep(instructions)) {
      throw structured("permission_denied", "compaction instructions blocked by the PII gate")
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    let settleBoundary!: (boundary: { boundaryId: string; messages?: unknown[] } | null) => void
    const boundaryPromise = new Promise<{ boundaryId: string; messages?: unknown[] } | null>(
      (resolve) => {
        settleBoundary = resolve
      }
    )
    const subscribe =
      options.subscribeCompactionEvents ??
      ((handler: (payload: unknown) => void) => onClaudeMessage(handler as never))
    const unsubscribe = await subscribe((payload) => {
      const boundary = readCompactionBoundary(payload, sessionId)
      if (boundary) settleBoundary(boundary)
    })

    try {
      await (options.compact ?? compactSession)(sessionId, instructions, { commandId })
      const timedOut = new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), options.compactionTimeoutMs ?? 30_000)
        timeout.unref?.()
      })
      return await Promise.race([boundaryPromise, timedOut])
    } finally {
      if (timeout) clearTimeout(timeout)
      unsubscribe()
    }
  }

  async function handle<Method extends RpcMethod>(
    method: Method,
    params: RpcMethodMap[Method]["params"],
    context: AgentRpcServiceContext
  ): Promise<RpcMethodMap[Method]["result"]> {
    const startedAt = now()
    const sessionId =
      typeof (params as Record<string, unknown>).sessionId === "string"
        ? ((params as Record<string, unknown>).sessionId as string)
        : undefined
    try {
      const value = await dispatch(method, params as RpcMethodMap[RpcMethod]["params"], context)
      publishAudit({
        id: randomUUID(),
        at: new Date(startedAt).toISOString(),
        method,
        ...(sessionId ? { sessionId } : {}),
        durationMs: Math.max(0, now() - startedAt),
        result: "ok",
      })
      return value as RpcMethodMap[Method]["result"]
    } catch (error) {
      const structuredError = (error as { structuredError?: { code?: string } }).structuredError
      publishAudit({
        id: randomUUID(),
        at: new Date(startedAt).toISOString(),
        method,
        ...(sessionId ? { sessionId } : {}),
        durationMs: Math.max(0, now() - startedAt),
        result: "error",
        errorCode:
          structuredError?.code ??
          (error instanceof AgentRpcHostError ? error.code : RPC_ERROR_CODES.internalError),
      })
      throw error
    }
  }

  function publishAudit(entry: RpcAuditEntry): void {
    try {
      auditStore.append(entry)
    } catch {
      // Audit I/O must never change the outcome of the operation being observed.
    }
    for (const [subscriptionId, subscription] of traceSubscriptions) {
      if (subscription.sessionId && subscription.sessionId !== entry.sessionId) continue
      void subscription.context.emit("trace/event", { subscriptionId, span: entry }).catch(() => {
        traceSubscriptions.delete(subscriptionId)
      })
    }
  }

  return {
    methods: SUPPORTED_METHODS,
    capabilities: serviceCapabilities,
    ...(options.workerDispatch ? { workerManifest: options.workerDispatch.manifest } : {}),
    handle,
    activeTurns: countActiveTurns,
    close,
  }

  /** Sessions with a turn in flight — the same count `runtime/status` reports. */
  function countActiveTurns(): number {
    return [...sessions.values()].filter((session) => session.busy).length
  }

  function uniqueSessionId(): string {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const candidate = options.mintSessionId
        ? options.mintSessionId(now(), random())
        : defaultMintSessionId(now(), random())
      if (!store.list().some((entry) => entry.sessionId === candidate)) return candidate
    }
    return `rpc-${now()}-${randomUUID().slice(0, 8)}`
  }

  function uniqueBranchId(sourceId: string, kind: "fork" | "clone"): string {
    const candidate = uniqueSessionId()
    return candidate === sourceId ? `${sourceId}-${kind}-${randomUUID().slice(0, 8)}` : candidate
  }
}

async function ensureExtensibilityRuntime(): Promise<void> {
  const { ensurePluginRuntime } = await import("../../plugin/plugin-runtime")
  const initialized = await ensurePluginRuntime()
  if (!initialized.ok) {
    throw structured("runtime_error", initialized.error ?? "plugin runtime failed to initialize")
  }
}

function invalidateSessionOptions(sessions: Map<string, HostedSession>): void {
  for (const session of sessions.values()) {
    session.config.pluginTools = true
    session.lease.current?.invalidateOptions?.()
  }
}

function readState(session: HostedSession): Record<string, unknown> {
  const persisted = session.durableState.read(session.id)
  const livePermissions = new Map(
    [...session.pendingPermissions.values()].map(({ request }) => [request.requestId, request])
  )
  for (const [requestId, request] of Object.entries(persisted.pendingPermissions)) {
    if (!livePermissions.has(requestId)) livePermissions.set(requestId, request as never)
  }
  return {
    sessionId: session.id,
    status: session.status,
    locked: session.busy,
    tags: persisted.tags,
    pendingPermissions: [...livePermissions.values()],
    pendingElicitations: Object.values(persisted.pendingElicitations),
    pendingExternalTools: Object.values(persisted.pendingExternalTools),
    recoveryRequired: persisted.recoveryRequired,
    spec: session.spec,
  }
}

function outcomeFrom(runResult: AgentRunResultV1): Record<string, unknown> {
  return { status: runResult.status, result: runResult }
}

function lowerInput(input: unknown): string {
  if (typeof input === "string" && input.trim()) return input
  if (
    input &&
    typeof input === "object" &&
    typeof (input as { prompt?: unknown }).prompt === "string"
  ) {
    const prompt = (input as { prompt: string }).prompt
    if (prompt.trim()) return prompt
  }
  throw structured("usage_error", "input must contain a non-empty prompt")
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== "string" || !value.trim()) {
    throw structured("usage_error", `${key} must be a non-empty string`)
  }
  return value
}

function commandIdFrom(params: Record<string, unknown>): string {
  return typeof params.commandId === "string" && params.commandId ? params.commandId : randomUUID()
}

function receipt(commandId: string): Record<string, unknown> {
  return { commandId, accepted: true }
}

async function runCommand<T>(
  session: HostedSession,
  method: string,
  params: Record<string, unknown>,
  operation: (commandId: string) => Promise<T>
): Promise<T> {
  const commandId = commandIdFrom(params)
  const key = `${method}:${commandId}`
  const existing = session.commandResults.get(key)
  if (existing) {
    const original = await existing
    return original as T
  }
  const pending = operation(commandId)
  session.commandResults.set(key, pending)
  try {
    const value = await pending
    session.durableState.update(session.id, (state) => {
      state.commandResults[key] = value
      const keys = Object.keys(state.commandResults)
      for (const stale of keys.slice(0, Math.max(0, keys.length - 1_000))) {
        delete state.commandResults[stale]
      }
    })
    return value
  } catch (error) {
    session.commandResults.delete(key)
    throw error
  }
}

function requireStore<T>(result: StoreResult<T>): T {
  if (!result.ok) throw structured(result.error.code, result.error.message, result.error)
  return result.value
}

function structured(code: string, message: string, detail?: unknown): Error {
  return Object.assign(new Error(message), {
    structuredError: { code, message, ...(detail !== undefined ? { detail } : {}) },
  })
}

function result<T>(value: T): T {
  return value
}

function readCompactionBoundary(
  payload: unknown,
  sessionId: string
): { boundaryId: string; messages?: unknown[] } | null {
  if (!payload || typeof payload !== "object") return null
  const envelope = payload as { type?: unknown; sessionId?: unknown; event?: unknown }
  if (envelope.type !== "event" || envelope.sessionId !== sessionId) return null
  if (!envelope.event || typeof envelope.event !== "object") return null
  const event = envelope.event as {
    type?: unknown
    subtype?: unknown
    uuid?: unknown
    compact_metadata?: unknown
  }
  if (event.type !== "system" || event.subtype !== "compact_boundary") return null
  const metadata =
    event.compact_metadata && typeof event.compact_metadata === "object"
      ? (event.compact_metadata as { pre_messages?: unknown })
      : undefined
  const messages = Array.isArray(metadata?.pre_messages) ? metadata.pre_messages : undefined
  return {
    boundaryId: `compact-${typeof event.uuid === "string" && event.uuid ? event.uuid : randomUUID()}`,
    ...(messages && messages.length > 0 ? { messages } : {}),
  }
}

function denyPending(session: HostedSession, message: string): void {
  for (const pending of session.pendingPermissions.values()) {
    pending.resolve({ decision: "deny", message })
  }
  session.pendingPermissions.clear()
}

function resumableTurnParams(params: Record<string, unknown>): Record<string, unknown> {
  const resumable: Record<string, unknown> = {}
  for (const key of ["timeoutMs", "idleTimeoutMs", "maxSteps", "includeDiagnostics"] as const) {
    if (params[key] !== undefined) resumable[key] = params[key]
  }
  return resumable
}

function attemptIndex(attemptId: string): number {
  const match = /:a(\d+)$/.exec(attemptId)
  return match ? Number(match[1]) : 0
}

function findRecoveredResponse(
  responses: Record<string, Record<string, unknown>> | undefined,
  requestId: string,
  matches: (value: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  const exact = responses?.[requestId]
  if (exact) return exact
  const compatible = Object.values(responses ?? {}).filter(matches)
  return compatible.length === 1 ? compatible[0] : undefined
}

function findRecoveredResponseEntry(
  responses: Record<string, Record<string, unknown>> | undefined,
  requestId: string,
  matches: (value: Record<string, unknown>) => boolean,
  excluded: ReadonlySet<string>
): { requestId: string; value: Record<string, unknown> } | undefined {
  const exact = responses?.[requestId]
  if (exact && !excluded.has(requestId)) return { requestId, value: exact }
  const compatible = Object.entries(responses ?? {}).filter(
    ([id, value]) => !excluded.has(id) && matches(value)
  )
  return compatible.length === 1
    ? { requestId: compatible[0]![0], value: compatible[0]![1] }
    : undefined
}

function normalizeExternalToolResponse(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw structured("usage_error", "external tool response must be an object")
  if (value.kind === "result") {
    if (!hasNoLeakingPiiDeep(value.value)) {
      throw structured("permission_denied", CLIENT_CALLBACK_PII_ERROR)
    }
    return { kind: "result", value: value.value }
  }
  if (value.kind === "error" && isRecord(value.error) && typeof value.error.code === "string") {
    const safeError = hasNoLeakingPiiDeep(value.error)
      ? value.error
      : { code: value.error.code, message: CLIENT_CALLBACK_PII_ERROR, retryable: false }
    return { kind: "error", error: safeError }
  }
  throw structured("usage_error", "external tool response has an unsupported kind")
}

function externalToolResponseOutput(response: Record<string, unknown>): unknown {
  const normalized = normalizeExternalToolResponse(response)
  if (normalized.kind === "result") return normalized.value
  const error = normalized.error as Record<string, unknown>
  throw structured(
    "tool_error",
    typeof error.message === "string" ? error.message : "client tool failed",
    error
  )
}

function permissionDecision(decision: Record<string, unknown>): {
  decision: "allow" | "deny"
  message?: string
} {
  const kind = decision.kind
  return kind === "approve" || kind === "approve_always"
    ? { decision: "allow" }
    : {
        decision: "deny",
        ...(typeof decision.reason === "string" ? { message: decision.reason } : {}),
      }
}

function elicitationToolResponse(
  sessionId: string,
  requestId: string,
  request: ReturnType<typeof parseAskUserArgs>,
  response: Record<string, unknown>
): PluginToolExecResponse {
  const kind = response.kind
  const rawValue = response.value
  const answer =
    kind === "submit" && rawValue && typeof rawValue === "object"
      ? (rawValue as { selected?: unknown; text?: unknown; cancelled?: unknown })
      : {}
  return {
    type: "plugin_tool_response",
    sessionId,
    toolUseId: requestId,
    result: formatAskUserAnswer(request, {
      selected: Array.isArray(answer.selected)
        ? answer.selected.filter((item): item is string => typeof item === "string")
        : [],
      text: typeof answer.text === "string" ? answer.text : "",
      cancelled: kind !== "submit" || answer.cancelled === true,
    }),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function cancelPendingElicitations(session: HostedSession, message: string): void {
  for (const [requestId, pending] of session.pendingElicitations) {
    pending.resolve({
      type: "plugin_tool_response",
      sessionId: session.id,
      toolUseId: requestId,
      error: message,
    })
  }
  session.pendingElicitations.clear()
}

function hasPendingRequests(state: {
  pendingPermissions: Record<string, unknown>
  pendingElicitations: Record<string, unknown>
  pendingExternalTools: Record<string, unknown>
}): boolean {
  return (
    Object.keys(state.pendingPermissions).length > 0 ||
    Object.keys(state.pendingElicitations).length > 0 ||
    Object.keys(state.pendingExternalTools).length > 0
  )
}

function hasPendingActions(
  state: Parameters<typeof hasPendingRequests>[0] & { suspendedTurn?: unknown }
): boolean {
  return hasPendingRequests(state) || state.suspendedTurn != null
}

function nextRecoveryStatus(session: HostedSession): HostedSession["status"] {
  return hasPendingActions(session.durableState.read(session.id)) ? "recovery_required" : "idle"
}

function requireSingleLiveSession(
  sessions: Map<string, HostedSession>,
  requestedId?: unknown
): HostedSession {
  if (typeof requestedId === "string") {
    const session = sessions.get(requestedId)
    if (session?.lease.current?.isLive?.()) return session
    throw structured("unsupported_capability", `session ${requestedId} is not live`)
  }
  const live = [...sessions.values()].filter((session) => session.lease.current?.isLive?.())
  if (live.length !== 1) {
    throw structured(
      "usage_error",
      "operation requires exactly one live session or an explicit sessionId"
    )
  }
  return live[0]!
}

async function waitWithDeadline(promise: Promise<unknown>, timeoutMs: unknown): Promise<void> {
  if (typeof timeoutMs !== "number") {
    await promise
    return
  }
  await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new AgentRpcHostError(RPC_ERROR_CODES.timeout, "wait timed out")),
        timeoutMs
      )
      timer.unref?.()
    }),
  ])
}
