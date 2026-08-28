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
import { DEFAULT_SANDBOX_SESSION_BINDING } from "@/lib/sandbox/binding"
import { sandboxSessionRuntime } from "@/lib/sandbox/session-runtime"
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
import { makeConfiguredCliPluginToolHandle } from "../configured-plugin-tool-handle"
import { bindCliSessionHostRuntime } from "../cli-host-runtime"
import { clearSessionHostRuntime } from "@/lib/plugin/runtime/host-runtime"
import type { AgentRpcService, AgentRpcServiceContext } from "./server"
import { AgentRpcHostError } from "./server"
import { AssetStoreError, createAssetStore, type AssetStore } from "./asset-store"
import { createTraceBridge, redactSpan, type TraceBridge } from "./trace-bridge"
import {
  AgentDefinitionStoreError,
  createAgentDefinitionStore,
  type AgentDefinitionStore,
} from "./agent-definition-store"
import { currentTurnContext, runInTurnContext, type RpcTurnContext } from "./session-context"
import {
  createDurableRpcStateStore,
  type DurableRpcStateStore,
  type DurableRpcSuspendedTurn,
} from "./durable-state"
import {
  computeToolSchemaDigest,
  type AgentDefinitionV1,
} from "@/packages/agent/src/agent-definition"
import {
  CAP_AGENT_DEFINITIONS_V1,
  CAP_AGENT_SESSION_BINDING_V1,
  CAP_ASSETS_V1,
  CAP_AUDIT_DURABLE_V1,
  CAP_CALLBACK_ATTRIBUTION_V1,
  CAP_CLIENT_HOOKS_V1,
  CAP_CLIENT_TOOLS_V1,
  CAP_COMMAND_RECEIPTS_V1,
  CAP_COMPACTION_UNDO_LIVE_V1,
  CAP_CONCURRENT_SESSIONS_V1,
  CAP_DURABLE_PROVIDER_SESSION_V1,
  CAP_ELICITATION_V1,
  CAP_EVALS_V1,
  CAP_EVENT_REPLAY_V2,
  CAP_EXTERNAL_TOOLS_V1,
  CAP_MCP_V1,
  CAP_PERMISSIONS_V1,
  CAP_PLUGINS_V1,
  CAP_SANDBOX_POLICY_V1,
  CAP_SESSION_FOREST_V1,
  CAP_SESSIONS_V1,
  CAP_SKILLS_V1,
  CAP_TASKS_V1,
  CAP_TRACE_UNSUBSCRIBE_V1,
  CAP_TRACES_REDACTED_V1,
  CAP_WORKER_DISPATCH_V1,
} from "@/packages/agent/src/capabilities"
import {
  RPC_ERROR_CODES,
  type HostRequestMethodMap,
  type RpcMethod,
  type RpcMethodMap,
} from "@/packages/agent/src/protocol"
import type { HandoffEnvelope } from "@/packages/agent/src/handoff-envelope"
import type { AgentSessionBinding, AgentWorkerManifestV1 } from "@/packages/agent/src/types"
import type { AgentCompositionSelectionV1 } from "@cognia/agent-config-types/agent-composition"
import { resolveTurnComposition } from "@/lib/agent/composition/resolve-turn-composition"
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
  "session/forest",
  "session/close",
  "agent/create",
  "agent/get",
  "agent/list",
  "agent/update",
  "agent/archive",
  "agent/restore",
  "agent/versions",
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
  "sandbox/policy/capture",
  "sandbox/policy/restore",
  "trace/subscribe",
  "trace/unsubscribe",
  "trace/export",
  "audit/query",
  "asset/put",
  "asset/register",
  "asset/stat",
  "asset/delete",
  "eval/replay",
  "eval/fixture/refresh",
  "eval/record/start",
  "eval/record/stop",
] as const satisfies readonly RpcMethod[]

/**
 * What this host actually implements, at the version it implements it.
 *
 * Every entry is a claim a client is entitled to act on, so each one has to be
 * true of *this* build. `worker-dispatch-v1` is appended only when worker
 * dispatch is configured, and `sandbox-policy-v1` deliberately does not promise
 * the filesystem checkpointing that `workspace-checkpoint-v1` would.
 */
const SERVICE_CAPABILITIES = [
  CAP_SESSIONS_V1,
  CAP_EVENT_REPLAY_V2,
  CAP_COMMAND_RECEIPTS_V1,
  CAP_CONCURRENT_SESSIONS_V1,
  CAP_DURABLE_PROVIDER_SESSION_V1,
  CAP_PERMISSIONS_V1,
  CAP_ELICITATION_V1,
  CAP_EXTERNAL_TOOLS_V1,
  CAP_CLIENT_TOOLS_V1,
  CAP_CLIENT_HOOKS_V1,
  CAP_CALLBACK_ATTRIBUTION_V1,
  CAP_MCP_V1,
  CAP_PLUGINS_V1,
  CAP_SKILLS_V1,
  CAP_TASKS_V1,
  CAP_SANDBOX_POLICY_V1,
  CAP_TRACES_REDACTED_V1,
  CAP_TRACE_UNSUBSCRIBE_V1,
  CAP_AUDIT_DURABLE_V1,
  CAP_COMPACTION_UNDO_LIVE_V1,
  CAP_SESSION_FOREST_V1,
  CAP_AGENT_DEFINITIONS_V1,
  CAP_AGENT_SESSION_BINDING_V1,
  CAP_ASSETS_V1,
  CAP_EVALS_V1,
] as const

/**
 * Host-side ceilings.
 *
 * Every one of these guarded a map that previously only ever grew: a client
 * that subscribed to traces in a loop, or resolved a few million commands over
 * a long-lived process, had no bound at all. They are announced in `initialize`
 * so a client can see them, and enforced here so an over-eager client is
 * rejected rather than tolerated until the host runs out of memory.
 */
const MAX_REPLAY_EVENTS = 10_000
const MAX_TRACE_SUBSCRIPTIONS = 64
const TRACE_SUBSCRIPTION_TTL_MS = 60 * 60_000
const MAX_RETAINED_COMMAND_RESULTS = 1_024
const AGENT_COMMAND_RECEIPT_SCOPE = ".agent-definition-command-receipts"

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
  /**
   * The agent version this session was created under, frozen at creation.
   * Absent for sessions created without an agent reference.
   */
  agentBinding?: AgentSessionBinding
  /** Immutable definition resolved by the frozen binding. */
  agentDefinition?: AgentDefinitionV1
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
  /**
   * In-flight bind of this session's sandbox ceiling into the shared runtime.
   * Awaited before a turn runs so a tool dispatch cannot race ahead of the
   * placement and fall back to the unpoliced host default.
   */
  sandboxBinding?: Promise<SandboxBindOutcome>
  workerHandoff?: HandoffEnvelope
}

type SandboxBindOutcome = { ok: true } | { ok: false; error: unknown }

export interface AgentRuntimeServiceOptions {
  config: ResolvedConfig
  home: string
  sessionDirOverride?: string
  store?: SessionStore
  /** Injected in tests; defaults to the on-disk store under `home`. */
  agentDefinitions?: AgentDefinitionStore
  /** Injected in tests; defaults to the content-addressed store under `home`. */
  assets?: AssetStore
  /** Injected in tests; defaults to a bridge over `@cognia/agent-trace`. */
  traces?: TraceBridge
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
  const agentStore: AgentDefinitionStore =
    options.agentDefinitions ?? createAgentDefinitionStore({ home: options.home, now })
  const assetStore: AssetStore = options.assets ?? createAssetStore({ home: options.home, now })
  const registeredTools = new Map<
    string,
    { pluginId: string; toolName: string; schemaDigest: string }
  >()
  const registeredHooks = new Map<string, { pluginId: string }>()
  const deletedCommands = new Map<string, Record<string, unknown>>()
  const createCommands = new Map<string, Promise<Record<string, unknown>>>()
  const agentCommands = new Map(
    Object.entries(durableState.read(AGENT_COMMAND_RECEIPT_SCOPE).commandResults).map(
      ([key, value]) => [key, Promise.resolve(value)] as const
    )
  )
  const traceSubscriptions = new Map<
    string,
    {
      sessionId?: string
      context: AgentRpcServiceContext
      createdAt: number
      includeContent: boolean
    }
  >()
  const traceBridge: TraceBridge = options.traces ?? createTraceBridge()
  /** Recording proxies the caller opened and has not yet stopped. */
  const recordings = new Map<
    string,
    { stop: () => Promise<{ fixture: unknown; actors: string[] }> }
  >()
  // Real spans, not audit rows: one `trace/event` per finished span, redacted
  // unless that subscriber explicitly asked for content.
  const detachSpanListener = traceBridge.onSpan((span) => {
    for (const [subscriptionId, subscription] of traceSubscriptions) {
      if (subscription.sessionId && subscription.sessionId !== span.sessionId) continue
      void subscription.context
        .emit("trace/event", {
          subscriptionId,
          span: redactSpan(span, subscription.includeContent) as unknown as Record<string, unknown>,
        })
        .catch(() => {
          traceSubscriptions.delete(subscriptionId)
        })
    }
  })
  const compactionSnapshots = new Map<string, CompactionSnapshot>()
  let configuredMcpServers: McpServer[] | null = null
  let closing = false
  const serviceCapabilities: readonly string[] = options.workerDispatch
    ? [...SERVICE_CAPABILITIES, CAP_WORKER_DISPATCH_V1]
    : SERVICE_CAPABILITIES

  function readEntries(params: Record<string, unknown>): Record<string, unknown> {
    const sessionId = requireString(params, "sessionId")
    const envelopes = store.readEnvelopes(sessionId)
    const afterEventId = typeof params.afterEventId === "string" ? params.afterEventId : undefined
    const requestedLimit = typeof params.limit === "number" ? params.limit : MAX_REPLAY_EVENTS
    const limit = Math.min(MAX_REPLAY_EVENTS, Math.max(1, requestedLimit))
    const cursorIndex = afterEventId
      ? envelopes.findIndex((envelope) => envelope.eventId === afterEventId)
      : -1
    if (afterEventId && cursorIndex === -1) {
      throw structured("usage_error", `unknown event cursor ${afterEventId}`)
    }
    const page = envelopes.slice(cursorIndex + 1, cursorIndex + 1 + limit)
    const hasMore = cursorIndex + 1 + page.length < envelopes.length
    // The newest persisted event at the instant of this call. A subscriber pages
    // up to exactly this id and then flushes what it buffered live, which is what
    // makes replay and live delivery a single ordered stream rather than a race.
    const headEventId = envelopes.at(-1)?.eventId
    return {
      entries: page.map((envelope) => ({ envelope })),
      ...(hasMore && page.length > 0 ? { nextEventId: page.at(-1)!.eventId } : {}),
      ...(headEventId !== undefined ? { headEventId } : {}),
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
    const persisted = durableState.read(sessionId)
    const agentDefinition = persisted.agentBinding
      ? withDefinitionErrors(() =>
          agentStore.get(persisted.agentBinding!.agentId, persisted.agentBinding!.version)
        )
      : undefined
    const runtimeConfig = lowerAgentDefinitionConfig(
      {
        ...config,
        cwd: opened.value.manifest.workspace || config.cwd,
        ...(opened.value.manifest.runtimeBinding?.backend
          ? { agentBackend: opened.value.manifest.runtimeBinding.backend }
          : {}),
        ...(opened.value.manifest.runtimeBinding?.model
          ? { model: opened.value.manifest.runtimeBinding.model }
          : {}),
      },
      agentDefinition
    )
    opened.value.close()
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
      ...(persisted.agentBinding ? { agentBinding: persisted.agentBinding } : {}),
      ...(agentDefinition ? { agentDefinition } : {}),
    }
    sessions.set(sessionId, session)
    // Bind the session's provider/search config so plugin `ctx.ai.*` and
    // `ctx.agent.invokeTool` calls resolve to THIS session. Several sessions
    // share this process with different credentials, so an unbound one must
    // fail closed rather than borrow another's account.
    bindCliSessionHostRuntime(session.config, session.id)
    void bindSandboxRuntime(session)
    return session
  }

  /**
   * Bind this session's persisted sandbox ceiling into the shared runtime so
   * `cognia-sandboxed-tools` clamps headless calls to it. The CLI has no send
   * envelope to carry the ref, so `plugin-tool-dispatch` looks it up by
   * session id — see `activeRefForSession`.
   *
   * The outcome is retained rather than discarded: a bind that failed means
   * the ceiling is NOT in force, and an operator who configured one is owed
   * that fact (surfaced as a `runtime/diagnostic` when the next turn starts).
   */
  function bindSandboxRuntime(session: HostedSession): Promise<SandboxBindOutcome> {
    const policy = session.durableState.read(session.id).sandboxPolicy as
      SandboxResourcePolicy | null | undefined
    const pending = sandboxSessionRuntime
      .bindSession({
        sessionId: session.id,
        binding: DEFAULT_SANDBOX_SESSION_BINDING,
        policy: policy ?? null,
        confine: null,
        sandboxEnabled: true,
        // The CLI binding is the host/local placement (`DEFAULT_SANDBOX_SESSION_BINDING`
        // is `os` + `local`), which is exactly where Computer Use ran on this
        // rail before the runtime reference existed. Declaring the surface
        // disabled would make `decorateComputerUseContext` reject every
        // `perform_action` / `get_app_state` the dispatcher stamps this ref
        // onto — a refusal with nothing behind it, since local IS the target.
        computerUseEnabled: true,
        ...(session.config.cwd ? { workspaceRoot: session.config.cwd } : {}),
      })
      .then<SandboxBindOutcome, SandboxBindOutcome>(
        () => ({ ok: true }),
        (error: unknown) => ({ ok: false, error })
      )
    session.sandboxBinding = pending
    return pending
  }

  /**
   * Settle the session's sandbox placement before work that can dispatch tools.
   * Without this the bind is still in flight when the first tool frame arrives,
   * `activeRefForSession` answers `undefined`, and the call runs against the
   * unpoliced host default instead of the configured ceiling.
   */
  async function awaitSandboxBinding(
    session: HostedSession,
    context: AgentRpcServiceContext
  ): Promise<void> {
    const outcome = await session.sandboxBinding
    if (!outcome || outcome.ok) return
    session.sandboxBinding = undefined
    await context.emit("runtime/diagnostic", {
      level: "error",
      message: `sandbox ceiling is not in force for session ${session.id}: ${
        outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
      }`,
    })
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
      case "session/tree": {
        const sessionId = requireString(params, "sessionId")
        const subtree = findSubtree(store.tree(), sessionId)
        if (!subtree) throw structured("session_not_found", `unknown session ${sessionId}`)
        return result({ roots: [subtree] })
      }
      case "session/forest":
        return result({ roots: store.tree() })
      case "agent/create":
        return result(
          await runAgentCommand(method, params, () =>
            withDefinitionErrors(() =>
              agentStore.create({
                ...(params.definition as Record<string, unknown>),
                ...(typeof params.agentId === "string" ? { agentId: params.agentId } : {}),
              } as never)
            )
          )
        )
      case "agent/get":
        return result(
          withDefinitionErrors(() =>
            agentStore.get(
              requireString(params, "agentId"),
              typeof params.version === "number" ? params.version : undefined
            )
          )
        )
      case "agent/list":
        return result({
          agents: withDefinitionErrors(() =>
            agentStore.list(params.includeArchived === true ? { includeArchived: true } : {})
          ),
        })
      case "agent/update":
        return result(
          await runAgentCommand(method, params, () =>
            withDefinitionErrors(() =>
              agentStore.update(
                requireString(params, "agentId"),
                params.expectedVersion as number,
                params.changes as never
              )
            )
          )
        )
      case "agent/archive":
        return result(
          await runAgentCommand(method, params, () =>
            withDefinitionErrors(() => agentStore.archive(requireString(params, "agentId")))
          )
        )
      case "agent/restore":
        return result(
          await runAgentCommand(method, params, () =>
            withDefinitionErrors(() => agentStore.restore(requireString(params, "agentId")))
          )
        )
      case "asset/put":
        return result(
          withAssetErrors(() =>
            assetStore.put({
              data: requireString(params, "data"),
              mediaType: requireString(params, "mediaType"),
              ...(typeof params.name === "string" ? { name: params.name } : {}),
            })
          )
        )
      case "asset/register":
        return result(
          withAssetErrors(() =>
            assetStore.registerPath({
              path: requireString(params, "path"),
              ...(typeof params.mediaType === "string" ? { mediaType: params.mediaType } : {}),
            })
          )
        )
      case "eval/replay": {
        const { runReplay } = await import("../../eval/replay/run-replay")
        const { createRuntimeDriver } = await import("../../eval/replay/runtime-driver")
        // The real agent loop with only the model endpoint substituted -- which
        // is what makes the run keyless rather than merely mocked.
        const replayResult = await runReplay({
          raw: params.fixture,
          requireSynthetic: params.requireSynthetic !== false,
          platform: "headless",
          driver: createRuntimeDriver({ config: options.config }),
          ...(typeof params.provider === "string" ? { provider: params.provider } : {}),
        })
        return result({
          ok: replayResult.ok,
          requests: replayResult.requests,
          unmatched: replayResult.unmatched,
          summary: replayResult.summary,
          ...(replayResult.scenarioId ? { scenarioId: replayResult.scenarioId } : {}),
          ...(replayResult.errors ? { errors: replayResult.errors } : {}),
          ...(replayResult.report
            ? { report: replayResult.report as unknown as Record<string, unknown> }
            : {}),
        })
      }
      case "eval/fixture/refresh": {
        const { refreshFixture } = await import("../../eval/replay/fixture-maintenance")
        return result(refreshFixture(params.fixture) as unknown as Record<string, unknown>)
      }
      case "eval/record/start": {
        const { createRecordingProxy } = await import("../../eval/replay/recording-proxy")
        const scenario = params.scenario as {
          actors?: { role?: string; actorRef?: string }[]
        }
        const rootActor = scenario.actors?.find((actor) => actor.role === "root")?.actorRef
        const proxy = createRecordingProxy({
          ...(typeof params.upstream === "string" ? { upstream: params.upstream } : {}),
          ...(typeof params.provider === "string" ? { provider: params.provider } : {}),
          ...(rootActor ? { defaultActorRef: rootActor } : {}),
        })
        await proxy.start(typeof params.port === "number" ? params.port : undefined)
        const recordingId = randomUUID()
        recordings.set(recordingId, {
          stop: async () => {
            await proxy.stop()
            const snapshot = proxy.snapshot()
            return {
              // Every tape is marked non-synthetic, so it cannot be committed
              // until a human has read and scrubbed it.
              fixture: {
                scenario: params.scenario,
                tapes: snapshot.tapes,
                assets: snapshot.assets,
              },
              actors: snapshot.actors,
            }
          },
        })
        return result({ recordingId, proxyUrl: proxy.baseUrl })
      }
      case "eval/record/stop": {
        const recordingId = requireString(params, "recordingId")
        const recording = recordings.get(recordingId)
        if (!recording) throw structured("usage_error", `unknown recording ${recordingId}`)
        recordings.delete(recordingId)
        const stopped = await recording.stop()
        return result({
          fixture: stopped.fixture as Record<string, unknown>,
          actors: stopped.actors,
        })
      }
      case "asset/stat":
        return result(withAssetErrors(() => assetStore.stat(requireString(params, "assetId"))))
      case "asset/delete":
        withAssetErrors(() => assetStore.delete(requireString(params, "assetId")))
        return result({ ok: true })
      case "agent/versions": {
        const agentId = requireString(params, "agentId")
        return result({
          agentId,
          versions: withDefinitionErrors(() => agentStore.versions(agentId)),
        })
      }
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
        evictOldest(deletedCommands)
        return result(deleted)
      }
      case "turn/run": {
        const session = materialize(requireString(params, "sessionId"))
        await awaitSandboxBinding(session, context)
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
            const contextualId = toolContext.sessionId ?? currentTurnContext()?.sessionId
            const session =
              (contextualId ? sessions.get(contextualId) : undefined) ??
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
        registeredTools.set(handlerId, {
          pluginId,
          toolName,
          // Computed from what the client actually registered, never taken on
          // trust from the caller, so a preflight compares like with like.
          schemaDigest: computeToolSchemaDigest({
            name: toolName,
            description: requireString(params, "description"),
            inputSchema: params.inputSchema as Record<string, unknown>,
            ...(params.outputSchema !== undefined
              ? { outputSchema: params.outputSchema as Record<string, unknown> }
              : {}),
            sideEffect: sideEffect as "none" | "idempotent" | "non-idempotent",
          }),
        })
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
          // The turn that actually fired this hook, from the async context the
          // turn established — not whichever session happens to be busy.
          const active = currentTurnContext()
          const invocationId = randomUUID()
          try {
            const response = await context.requestClient(
              "client/hook/invoke",
              {
                handlerId,
                invocationId,
                sessionId: active?.sessionId ?? "runtime",
                runId: active?.runId ?? `run-${invocationId}`,
                attemptId: active?.attemptId ?? `attempt-${invocationId}`,
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
        const policy = persisted.sandboxPolicy as SandboxResourcePolicy | null
        return result({
          enabled: policy !== null,
          policy,
          workspace: session.config.cwd,
          snapshotCount: Object.keys(persisted.sandboxSnapshots).length,
        })
      }
      case "sandbox/policy/capture": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const policyRecordId = `sandbox-policy-${randomUUID()}`
            const createdAt = new Date(now()).toISOString()
            const active = session.durableState.read(session.id)
              .sandboxPolicy as SandboxResourcePolicy | null
            session.durableState.update(session.id, (state) => {
              state.sandboxSnapshots[policyRecordId] = {
                snapshotId: policyRecordId,
                createdAt,
                policy: active ? { ...active } : null,
              }
            })
            return { policyRecordId, createdAt, commandId }
          })
        )
      }
      case "sandbox/policy/restore": {
        const session = materialize(requireString(params, "sessionId"))
        return result(
          await runCommand(session, method, params, async (commandId) => {
            const policyRecordId = requireString(params, "policyRecordId")
            const record = session.durableState.read(session.id).sandboxSnapshots[policyRecordId]
            if (!record) {
              throw structured("usage_error", `unknown sandbox policy record ${policyRecordId}`)
            }
            session.durableState.update(session.id, (state) => {
              state.sandboxPolicy = record.policy ? { ...record.policy } : null
            })
            // Re-bind so the restored ceiling is the one the sandbox tools
            // clamp against, not just a value in durable state. A restore whose
            // rebind failed did not restore anything enforceable, so it reports
            // failure rather than acknowledging a ceiling that is not applied.
            const rebound = await bindSandboxRuntime(session)
            if (!rebound.ok) {
              throw structured(
                "internal_error",
                `sandbox policy ${policyRecordId} was persisted but could not be bound: ${
                  rebound.error instanceof Error ? rebound.error.message : String(rebound.error)
                }`
              )
            }
            session.lease.current?.invalidateOptions?.()
            return { ...receipt(commandId), policyRecordId }
          })
        )
      }
      case "trace/subscribe": {
        reapTraceSubscriptions()
        if (traceSubscriptions.size >= MAX_TRACE_SUBSCRIPTIONS) {
          throw structured(
            "usage_error",
            `trace subscription limit reached (${MAX_TRACE_SUBSCRIPTIONS}); unsubscribe first`
          )
        }
        const subscriptionId = randomUUID()
        const includeContent = params.includeContent === true
        traceSubscriptions.set(subscriptionId, {
          ...(typeof params.sessionId === "string" ? { sessionId: params.sessionId } : {}),
          context,
          createdAt: now(),
          includeContent,
        })
        return result({ subscriptionId, redacted: !includeContent })
      }
      case "trace/unsubscribe": {
        const subscriptionId = requireString(params, "subscriptionId")
        traceSubscriptions.delete(subscriptionId)
        return result({ ok: true })
      }
      case "trace/export": {
        const format = typeof params.format === "string" ? params.format : "json"
        if (format !== "json" && format !== "otlp-json") {
          throw structured("unsupported_capability", `trace format ${format} is not supported`)
        }
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined
        const exported = traceBridge.export({ ...(sessionId ? { sessionId } : {}), format })
        // The audit rows stay available alongside the spans; they answer a
        // different question (which method ran, and how it ended) and callers
        // relied on them before spans existed.
        return result(
          format === "otlp-json"
            ? { redacted: true, ...exported }
            : {
                redacted: true,
                ...exported,
                audit: auditStore.exportTrace(sessionId),
              }
        )
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
      evictOldest(createCommands)
      return replay
    }

    const pending = createSessionOnce(params, commandId, commandKey)
    createCommands.set(commandKey, pending)
    evictOldest(createCommands)
    try {
      return await pending
    } catch (error) {
      createCommands.delete(commandKey)
      throw error
    }
  }

  async function runAgentCommand<T>(
    method: string,
    params: Record<string, unknown>,
    operation: () => T | Promise<T>
  ): Promise<T> {
    const key = `${method}:${commandIdFrom(params)}`
    const existing = agentCommands.get(key)
    if (existing) return (await existing) as T

    const pending = Promise.resolve().then(operation)
    agentCommands.set(key, pending)
    evictOldest(agentCommands)
    try {
      const value = await pending
      durableState.update(AGENT_COMMAND_RECEIPT_SCOPE, (state) => {
        state.commandResults[key] = value
        const keys = Object.keys(state.commandResults)
        for (const stale of keys.slice(0, -MAX_RETAINED_COMMAND_RESULTS)) {
          delete state.commandResults[stale]
        }
      })
      return value
    } catch (error) {
      agentCommands.delete(key)
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
      throw structured("unsupported_capability", `host does not support ${CAP_WORKER_DISPATCH_V1}`)
    }
    if (handoff && typeof params.cwd === "string") {
      throw structured("usage_error", "remote handoff session creation does not accept cwd")
    }
    // Resolved exactly once, here. `latest` is a creation-time question: after
    // this the session carries the precise version and its digests, and a later
    // `agent/update` cannot retroactively change what this session runs.
    const agentRef = params.agent as { agentId: string; version?: number } | undefined
    const definition: AgentDefinitionV1 | undefined = agentRef
      ? withDefinitionErrors(() => agentStore.get(agentRef.agentId, agentRef.version))
      : undefined
    if (definition?.archivedAt !== undefined && agentRef?.version === undefined) {
      throw structured(
        "agent_archived",
        `agent ${definition.agentId} is archived; pin an explicit version to keep using it`,
        { agentId: definition.agentId }
      )
    }
    const base = options.config
    const handoffWorkspace = handoff
      ? await options.workerDispatch!.resolveHandoffWorkspace(handoff, commandId)
      : undefined
    const config = lowerAgentDefinitionConfig(
      {
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
      },
      definition
    )
    const id = uniqueSessionId()
    const spec = resolveSessionExecutionSpec(config, { sessionId: id, runId: id })
    const resolvedComposition = definition
      ? await resolveTurnComposition({
          selection: definition.composition as AgentCompositionSelectionV1,
          systemPrompt: config.systemPrompt,
          tools: definition.toolRefs.map((tool) => ({
            name: tool.name,
            schema: tool.inputSchema,
            visibility: definition.composition.toolPresentation === "code" ? "code" : "native",
          })),
          executionFingerprint: spec.executionFingerprint,
        })
      : undefined
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
      ...(definition ? { agentDefinition: definition } : {}),
    }
    if (Array.isArray(params.tags) && params.tags.length > 0) {
      durableState.update(id, (state) => {
        state.tags = [...new Set((params.tags as string[]).map((tag) => tag.trim()))]
      })
    }
    const agentBinding: AgentSessionBinding | undefined = definition
      ? {
          agentId: definition.agentId,
          version: definition.version,
          definitionDigest: definition.definitionDigest,
          compositionPresetId: definition.composition.presetId,
          compositionDigest: resolvedComposition!.compositionDigest,
          executionFingerprint: spec.executionFingerprint,
        }
      : undefined
    if (agentBinding) {
      session.agentBinding = agentBinding
      durableState.update(id, (state) => {
        state.agentBinding = agentBinding
      })
    }
    sessions.set(id, session)
    bindCliSessionHostRuntime(session.config, session.id)
    // `createSessionOnce` registers the session itself instead of going through
    // `materialize`, so without this a freshly created session never bound its
    // ceiling at all — only one recovered from disk on a later call did.
    void bindSandboxRuntime(session)
    const createdResult = {
      sessionId: id,
      spec,
      commandId,
      ...(agentBinding ? { agentBinding } : {}),
    }
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
    preflightDefinitionTools(session)
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
    // Mutable on purpose: the real run and attempt ids only exist once the
    // runtime emits its first envelope, and the async context holds a reference
    // to this object rather than a copy of its fields.
    const turnContext: RpcTurnContext = {
      sessionId: session.id,
      runId: recovery?.runId ?? `run-pending:${session.id}`,
      attemptId: `attempt-pending:${session.id}`,
    }
    const traceSpanId = traceBridge.begin({
      operationName: "invoke_agent",
      providerName: `cognia.agent-rpc`,
      surface: "agent-rpc",
      sessionId: session.id,
      spanKind: "server",
      ...(session.config.model ? { requestModel: session.config.model } : {}),
      ...(session.agentBinding ? { agentId: session.agentBinding.agentId } : {}),
      inputPreview: prompt,
    })
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
          ...(session.agentDefinition
            ? {
                compositionSelection: session.agentDefinition
                  .composition as AgentCompositionSelectionV1,
              }
            : {}),
          ...(session.agentDefinition?.output
            ? { outputSchema: session.agentDefinition.output.schema }
            : {}),
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
            turnContext.runId = envelope.runId
            turnContext.attemptId = envelope.attemptId
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
        const { result: runResult } = await runInTurnContext(turnContext, () => runTurn(turnParams))
        session.durableState.update(session.id, (state) => {
          if (hasPendingRequests(state)) {
            state.recoveryRequired = true
            return
          }
          state.suspendedTurn = null
          state.recoveryRequired = false
        })
        traceBridge.finish(traceSpanId, {
          ...(runResult.status !== "completed"
            ? {
                errorType: runResult.status,
                ...(runResult.error?.message ? { errorMessage: runResult.error.message } : {}),
              }
            : {}),
          ...(runResult.text ? { outputPreview: runResult.text } : {}),
          metadata: { runId: runResult.runId, turnId: runResult.turnId, status: runResult.status },
        })
        return outcomeFrom(runResult)
      } catch (error) {
        traceBridge.finish(traceSpanId, {
          errorType: "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
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
    const fallback = makeConfiguredCliPluginToolHandle(session.config)
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
    await sandboxSessionRuntime.releaseSession(session.id).catch(() => undefined)
    clearSessionHostRuntime(session.id)
    session.status = "closed"
    sessions.delete(session.id)
  }

  async function close(): Promise<void> {
    if (closing) return
    detachSpanListener()
    traceBridge.close()
    // A recording proxy holds a listening socket; leaving one open would keep
    // the process alive after the client disconnected.
    for (const [recordingId, recording] of recordings) {
      recordings.delete(recordingId)
      await recording.stop().catch(() => undefined)
    }
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

  /**
   * Refuse to run a turn whose agent declares tools the client cannot serve.
   *
   * A definition stores a tool contract and its digest but never a handler, so
   * the handler is only real while a client is connected and has registered it.
   * Discovering that mid-turn means the model has already been told the tool
   * exists and has already decided to call it; checking here turns a confusing
   * tool failure into a clear precondition failure before any tokens are spent.
   */
  function preflightDefinitionTools(session: HostedSession): void {
    const binding = session.agentBinding
    if (!binding) return
    let definition: AgentDefinitionV1
    try {
      definition = agentStore.get(binding.agentId, binding.version)
    } catch {
      // The frozen version is unreadable; that is a definition problem, not a
      // handler problem, and `agent/get` reports it precisely.
      return
    }
    if (definition.toolRefs.length === 0) return
    const byDigest = new Map<string, string>()
    for (const registered of registeredTools.values()) {
      byDigest.set(`${registered.toolName}:${registered.schemaDigest}`, registered.toolName)
    }
    const byName = new Set([...registeredTools.values()].map((entry) => entry.toolName))

    const missing: string[] = []
    const mismatched: string[] = []
    for (const tool of definition.toolRefs) {
      if (!byName.has(tool.name)) {
        missing.push(tool.name)
      } else if (!byDigest.has(`${tool.name}:${tool.schemaDigest}`)) {
        mismatched.push(tool.name)
      }
    }
    if (missing.length > 0) {
      throw structured(
        "handler_unavailable",
        `agent ${binding.agentId}@${binding.version} declares tools with no registered handler: ` +
          missing.join(", "),
        { agentId: binding.agentId, version: binding.version, tools: missing }
      )
    }
    if (mismatched.length > 0) {
      throw structured(
        "schema_mismatch",
        `registered handlers for ${mismatched.join(", ")} do not match the schema digest the ` +
          `definition ${binding.agentId}@${binding.version} recorded`,
        { agentId: binding.agentId, version: binding.version, tools: mismatched }
      )
    }
  }

  /** Drop subscriptions past their TTL so an abandoned client cannot pin them. */
  function reapTraceSubscriptions(): void {
    const cutoff = now() - TRACE_SUBSCRIPTION_TTL_MS
    for (const [subscriptionId, subscription] of traceSubscriptions) {
      if (subscription.createdAt <= cutoff) traceSubscriptions.delete(subscriptionId)
    }
  }

  function publishAudit(entry: RpcAuditEntry): void {
    try {
      auditStore.append(entry)
    } catch {
      // Audit I/O must never change the outcome of the operation being observed.
    }
    // Audit rows are deliberately NOT fanned out on `trace/event` any more.
    // They record which method ran, not a span: no trace id, no parent, no
    // duration tree. Mixing them into the span stream left a subscriber unable
    // to tell one from the other. They stay on `audit/query` and in the JSON
    // trace export's `audit` block.
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

/** Project an immutable definition onto the CLI's existing config authority. */
function lowerAgentDefinitionConfig(
  config: ResolvedConfig,
  definition?: AgentDefinitionV1
): ResolvedConfig {
  if (!definition) return config
  const appended = definition.instructions?.append
  const runtimeBindingRef = definition.runtimeBindingRef ?? definition.composition.runtimeBindingRef
  return {
    ...config,
    ...(appended
      ? { systemPrompt: config.systemPrompt ? `${config.systemPrompt}\n\n${appended}` : appended }
      : {}),
    ...(runtimeBindingRef ? { agentBackend: runtimeBindingRef } : {}),
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
    ...(session.agentBinding ? { agentBinding: session.agentBinding } : {}),
    tags: persisted.tags,
    pendingPermissions: [...livePermissions.values()],
    pendingElicitations: Object.values(persisted.pendingElicitations),
    pendingExternalTools: Object.values(persisted.pendingExternalTools),
    recoveryRequired: persisted.recoveryRequired,
    spec: session.spec,
  }
}

/**
 * The node for `sessionId` anywhere in the lineage forest, with its children.
 *
 * `session/tree` used to ignore its argument and hand back every root, so a
 * caller asking about one session received the whole forest — including the
 * names and shapes of sessions it never asked about.
 */
function findSubtree<T extends { sessionId: string; children: T[] }>(
  roots: readonly T[],
  sessionId: string
): T | undefined {
  const stack = [...roots]
  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    if (node.sessionId === sessionId) return node
    stack.push(...node.children)
  }
  return undefined
}

/**
 * Insertion-ordered eviction for the receipt maps.
 *
 * Deduplication only has to survive a client retrying a command it believes may
 * not have landed, which happens near in time. Retaining every receipt for the
 * life of the process bought nothing and had no ceiling; `session/create` and
 * the per-session command map had none at all.
 */
function evictOldest(map: Map<string, unknown>): void {
  while (map.size > MAX_RETAINED_COMMAND_RESULTS) {
    const oldest = map.keys().next()
    if (oldest.done) return
    map.delete(oldest.value)
  }
}

/**
 * Map definition-store failures onto the wire's structured error codes.
 *
 * A version conflict in particular has to arrive as `version_conflict` rather
 * than as a generic internal error, because it is the one failure a caller is
 * expected to handle by re-reading and retrying.
 */
/** Map asset-store failures onto the wire's structured error codes. */
function withAssetErrors<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (!(error instanceof AssetStoreError)) throw error
    switch (error.code) {
      case "not_found":
        throw structured("asset_not_found", error.message, error.detail)
      case "too_large":
        throw structured("asset_too_large", error.message, error.detail)
      default:
        throw structured("usage_error", error.message, error.detail)
    }
  }
}

function withDefinitionErrors<T>(operation: () => T): T {
  try {
    return operation()
  } catch (error) {
    if (!(error instanceof AgentDefinitionStoreError)) throw error
    switch (error.code) {
      case "not_found":
        throw structured("agent_not_found", error.message, error.detail)
      case "version_conflict":
        throw structured("version_conflict", error.message, error.detail)
      case "already_exists":
        throw structured("agent_exists", error.message, error.detail)
      case "archived":
        throw structured("agent_archived", error.message, error.detail)
      default:
        throw structured("usage_error", error.message, error.detail)
    }
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
    const attachments = (input as { attachments?: unknown }).attachments
    // This host reads no attachment field. Accepting one and running the turn
    // without it is a silent data loss the caller cannot detect, so refuse.
    if (Array.isArray(attachments) && attachments.length > 0) {
      throw structured(
        "usage_error",
        `input carries ${attachments.length} attachment(s); this host accepts none.`
      )
    }
    const assets = (input as { assets?: unknown }).assets
    // The asset *store* works, but `UnifiedTurnParams` has nowhere to put a
    // reference, so the runtime would never read it. Refusing keeps the
    // `assets-in-turn-v1` capability honest instead of dropping the reference.
    if (Array.isArray(assets) && assets.length > 0) {
      throw structured(
        "unsupported_capability",
        `input carries ${assets.length} asset reference(s); this host stores assets but its ` +
          "agent runtime cannot read one during a turn yet (assets-in-turn-v1 is not declared)."
      )
    }
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
  evictOldest(session.commandResults)
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
