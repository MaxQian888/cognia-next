import { drainPendingRoundTrips } from "../common/round-trips.ts"
import { createOutputReviewer } from "./output-review.ts"
import { createCompactor } from "./compaction.ts"
import type { ToolSet } from "ai"
import type { SendOptions, Prompt } from "../../shared/wire/inbound.ts"
import type { HostRpcCaller } from "../../tools/state/host-background-shells.ts"
import type { AdapterCredentials } from "../../providers/protocol-adapters/types.ts"
import type { ProtocolExecChannel } from "../../providers/protocol-adapters/code-adapter.ts"
import type { ConversationMessage } from "../../context/compaction.ts"
import type { CallLedgerGate, CallReport } from "../common/call-ledger-gate.ts"
import type { PendingApproval } from "../../policy/permission/approval.ts"
import type { PendingPluginToolCalls } from "../../tools/plugin/server.ts"
import type { PendingPluginHooks } from "../../hooks/kernel/types.ts"
import type { McpToolsOptions } from "../../mcp/client/types.ts"
import type { createAiSdkToolSearchController } from "../../tools/adapters/ai-sdk-tool-search.ts"
import { record } from "./messages.ts"
export interface DispatchAiSdkOptions {
  provider: string
  sessionId: string
  firstPrompt: Prompt
  sendOptions: SendOptions
  emit(event: Record<string, unknown>): void
  log(level: string, message: string): void
  hostRpc?: HostRpcCaller
  streamText?: (args: Record<string, unknown>) => unknown
  buildMcpTools?: (
    options: McpToolsOptions
  ) => Promise<Awaited<ReturnType<typeof import("../../mcp/client/tools.ts").buildAiSdkMcpTools>>>
  streamIdleTimeoutMs?: number
}
import { createToolSessionContext } from "../../tools/session.ts"
// AI SDK dispatcher: runs a turn against `streamText()` from the `ai` package
// using `@ai-sdk/<provider>`'s client builder.
//
// Lazy-imports the per-provider SDKs so the sidecar's cold start doesn't pay
// for OpenAI when the user is on Anthropic, etc.
//
// Tool-calling IS wired (ADR-0043 Phase 2): built-in tools + renderer-proxied
// plugin tools are converted to native AI SDK tools by `ai-sdk-tools.mjs` and
// driven through `streamText`'s multi-step loop. Tool execution is gated by the
// same `permission_request` round-trip as the Anthropic path (resolved via
// `pendingApprovals`), so a local model can't silently run shell/process tools.
// A2UI remains Anthropic-only by design.

import { randomUUID } from "node:crypto"
import { classifyProviderError } from "@cognia/provider-routing/error-classifier"
import { createEventAdapter } from "./events.ts"
import { makeInputStream } from "../../shared/input-stream.ts"
import { extractHttpErrorMeta } from "../../providers/http-error-meta.ts"
import {
  classifyCallError,
  createCallLedgerGate,
  estimatePromptTokens,
  isRetryableBeforeOutput,
  rawUsageFromAiSdk,
  refusalSessionEnded,
} from "../common/call-ledger-gate.ts"
import {
  STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  withIdleTimeout,
} from "../../providers/stream-watchdog.ts"
import { resolveAdapter } from "../../providers/protocol-adapters/registry.ts"
import { buildModel } from "../../providers/protocol-adapters/ai-sdk-adapter.ts"
import {
  resolveProviderProtocol,
  normalizeProtocol,
  isMisroutedToOpenAi,
} from "../../providers/provider-protocol.ts"
import { sanitizeToolMessagePairs } from "../../context/tool-message-pairing.ts"
import { buildMcpLogEvent } from "../../mcp/client/log.ts"

// Bounded retries for a transport/stream failure before any output was
// produced — the non-ledger counterpart of the reserved-attempt budget.
const MAX_TRANSPORT_RETRIES = 2

// Consecutive legs allowed to end on an unmapped finishReason ("other" /
// "unknown") while still producing fresh output. Beyond that the model is
// treated as done — a provider that always reports "other" must not spin
// the loop forever.
const MAX_UNKNOWN_FINISH_CONTINUES = 3

// Map a provider id (or explicit `protocol` field) to the AI SDK family the
// renderer uses to construct a model instance. Custom provider ids must
// supply `providerCredentials.protocol` because the id alone tells us nothing.
// The id→protocol table is the single source of truth in `provider-protocol.mjs`;
// the renderer's resolver forwards `providerCredentials.protocol` for every turn,
// so this id-based path is the fallback for callers that don't (CLI, older code).
function resolveProtocol(provider: string, credentials?: AdapterCredentials, model?: string) {
  if (provider === "commandcode") return resolveProviderProtocol(provider, model)
  if (credentials?.protocol) return normalizeProtocol(credentials.protocol)
  return resolveProviderProtocol(provider)
}

// `buildModel` moved to `src/providers/protocol-adapters/ai-sdk-adapter.ts`
// (the built-in adapter behind the ProtocolAdapter seam); re-imported above so
// the `__testing__` surface stays stable.

/**
 * Drop `reasoning` parts from assistant messages before they re-enter the
 * conversation history. Reasoning models (deepseek-reasoner et al.) reject
 * requests whose history contains reasoning content (HTTP 400), and even
 * where accepted, per-turn reasoning traces poison the provider's prompt-
 * cache prefix. Assistant messages whose content becomes empty after the
 * filter are dropped entirely; non-assistant messages pass through untouched.
 */
/**
 * Best-effort human-readable message from an arbitrary thrown/streamed error
 * value. Guards `JSON.stringify` — a circular provider error object must not
 * throw inside an error-reporting path.
 */
import {
  errorToMessage,
  stripReasoningParts,
  toAiSdkUserContent,
  toolOutputHasImage,
  projectToolResultImages,
} from "./messages.ts"

/**
 * How many agentic steps to charge a finished leg against the turn's step
 * budget. `result.steps` is an AI-SDK getter that REJECTS on a partial-error
 * leg, so the real count isn't always available:
 *  - read OK, count > 0 → the real count (clamped to the per-leg cap)
 *  - read OK, count 0   → the per-leg cap (defensive: don't under-count a leg
 *    that ran but reported nothing)
 *  - read FAILED        → a conservative 1 (the leg ran ≥1 step), NOT the full
 *    cap — over-charging here burns the agentic budget far faster than the work
 *    actually done and trips the safety-cap notice prematurely.
 *
 * Exported via `__testing__`.
 *
 * @param {{ legStepsRead: boolean, legStepsRun: number, perLegCap: number }} p
 * @returns {number}
 */
function chargeLegSteps({
  legStepsRead,
  legStepsRun,
  perLegCap,
}: {
  legStepsRead: boolean
  legStepsRun: number
  perLegCap: number
}) {
  if (!legStepsRead) return 1
  return legStepsRun > 0 ? Math.min(legStepsRun, perLegCap) : perLegCap
}

/**
 * Resolve the per-leg agentic step cap (STEP_CHUNK). A caller-supplied
 * `aiSdkStepChunk` (≥ 1, floored) raises/lowers how many sequential tool-use
 * steps run per `streamText` leg; anything invalid falls back to the default 16.
 * Exported via `__testing__`.
 *
 * @param {unknown} aiSdkStepChunk
 * @returns {number}
 */
function resolveStepChunk(aiSdkStepChunk: unknown) {
  return typeof aiSdkStepChunk === "number" && aiSdkStepChunk >= 1 ? Math.floor(aiSdkStepChunk) : 16
}

/**
 * @param {{
 *   provider: string,
 *   sessionId: string,
 *   firstPrompt: any,
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   log: (level: "info"|"warn"|"error", message: string) => void,
 *   streamText?: any,  // injected for tests
 *   buildMcpTools?: (params: any) => Promise<{ tools: Record<string, any>, close: () => Promise<void> }>,  // injected for tests
 * }} params
 */
export function dispatchAiSdk({
  provider,
  sessionId,
  firstPrompt,
  sendOptions,
  emit,
  log,
  hostRpc,
  streamText: streamTextOverride,
  buildMcpTools: buildMcpToolsOverride,
  streamIdleTimeoutMs,
}: DispatchAiSdkOptions) {
  // Code-level protocol adapters round-trip through the renderer; the host
  // resolves `protocol_adapter_*` against this Map (per-session, like
  // pendingPluginToolCalls).
  const pendingProtocolExecs = new Map<string, ProtocolExecChannel>()
  const protocol = resolveProtocol(provider, sendOptions.providerCredentials, sendOptions.model)

  // `@agent` single-turn routing on the ai-sdk path. The SDK-native `agent`
  // field (Anthropic path) has no equivalent here, so we synthesize the
  // subagent's IDENTITY from its `AgentDefinition`: prepend its system prompt,
  // narrow the tool allowlist to its `tools`, UNION its `disallowedTools` onto
  // the turn's deny-list, and clamp the agentic loop by its `maxTurns` — parity
  // with the Anthropic Agent SDK, which honors all of these. We deliberately do
  // NOT override the model — a subagent's model usually names a Claude id that
  // the active non-Anthropic provider can't serve; the user's chosen provider
  // model stays in force. Mirrors the `synthesizeCharacter` overlay used by the
  // team/dispatch executor.
  const agentOverlay =
    sendOptions.agent && sendOptions.agents ? sendOptions.agents[sendOptions.agent] : null
  const agentSystemPrompt =
    agentOverlay && typeof agentOverlay.prompt === "string" && agentOverlay.prompt.trim().length > 0
      ? agentOverlay.prompt
      : null
  const agentAllowedTools =
    agentOverlay && Array.isArray(agentOverlay.tools) ? agentOverlay.tools : null
  const agentDisallowedTools =
    agentOverlay &&
    Array.isArray(agentOverlay.disallowedTools) &&
    agentOverlay.disallowedTools.length
      ? agentOverlay.disallowedTools
      : null
  const agentMaxTurns =
    agentOverlay && typeof agentOverlay.maxTurns === "number" && agentOverlay.maxTurns > 0
      ? agentOverlay.maxTurns
      : null
  // The turn's sendOptions narrowed to the routed agent's tool scope. Reused for
  // both built-in/plugin tool building and the MCP tool/gate path so the agent's
  // allow + deny lists apply uniformly. Identity when no agent is routed.
  const agentScopedSendOptions =
    agentAllowedTools || agentDisallowedTools
      ? {
          ...sendOptions,
          ...(agentAllowedTools ? { allowedTools: agentAllowedTools } : {}),
          ...(agentDisallowedTools
            ? {
                disallowedTools: [
                  ...new Set([...(sendOptions.disallowedTools ?? []), ...agentDisallowedTools]),
                ],
              }
            : {}),
        }
      : sendOptions

  // The Anthropic protocol carries images inside tool-result messages natively;
  // every other protocol we drive (openai / google / mistral / cohere) either
  // can't, or only can on specific endpoints/model versions — so for them we end
  // the leg right after a tool returns an image and re-project it as a user
  // message (see `projectToolResultImages`). Anthropic keeps its native path.
  const projectToolImages = protocol !== "anthropic"
  // Resolve the protocol adapter behind the seam: built-in protocols use the
  // @ai-sdk/* path; non-builtin protocol ids need a declarative spec or a
  // code adapter (plugin-contributed, forwarded via
  // sendOptions.protocolAdapterSpec).
  const resolvedAdapter = resolveAdapter(protocol, sendOptions.protocolAdapterSpec, {
    emit,
    sessionId,
    pendingProtocolExecs,
    remoteExecutionContext: sendOptions.remoteExecutionContext,
    onCancel: (execId, reason) => {
      emit({
        type: "protocol_adapter_cancel",
        sessionId,
        execId,
        reason,
        ...(sendOptions.remoteExecutionContext
          ? { remoteExecutionContext: sendOptions.remoteExecutionContext }
          : {}),
      })
    },
  })
  if (!resolvedAdapter) {
    emit({
      type: "session_ended",
      sessionId,
      error: `provider "${provider}" has no resolvable AI SDK protocol — set providerCredentials.protocol explicitly`,
    })
    return null
  }

  const protocolAdapter = resolvedAdapter

  // Live-switchable. The renderer can change the model mid-session via the
  // `setModel` session control (see the `q.setModel` below, the ai-sdk parity
  // for the Anthropic SDK's `Query.setModel`). It's a `let` so every closure
  // that reads it — `maybeCompact`, the agent-loop `protocolAdapter.start`, and
  // the auto-compaction threshold — picks up the new model on the NEXT turn
  // without tearing down the multi-turn loop (which would drop the in-process
  // conversation). Validated once here with its initial value.
  let model = sendOptions.model ?? ""
  if (!model) {
    emit({
      type: "session_ended",
      sessionId,
      error: `model is required when provider is "${provider}"`,
    })
    return null
  }

  // Missing-credential guard. `resolveSendOptions` deliberately lets an
  // unconfigured non-Anthropic provider fall through here with no
  // `providerCredentials`, expecting the sidecar to emit a clean, provider-named
  // "missing credential" error (build-options.ts). Without this, an openai-
  // protocol provider with no key (e.g. switching to DeepSeek / OpenCode without
  // a configured key) reaches `@ai-sdk/openai`, which throws the misleading
  // "OpenAI API key is missing" — confusing when the user never selected OpenAI.
  // A provider with neither a key nor a base URL cannot authenticate or even
  // reach a local endpoint, so fail fast and clearly. Local engines (ollama,
  // lmstudio, …) always carry a base URL and so pass this check.
  const resolvedCreds = sendOptions.providerCredentials ?? {}
  if (!resolvedCreds.apiKey && !resolvedCreds.baseURL) {
    emit({
      type: "session_ended",
      sessionId,
      error: `provider "${provider}" is not configured: no API key or base URL was found. Add credentials for "${provider}" (CLI: ~/.cognia/credentials.json or the matching *_API_KEY env var; desktop: Settings → Providers) and try again.`,
    })
    return null
  }

  // Credential-leak guard. A built-in openai-PROTOCOL provider that is NOT a
  // genuine OpenAI host (every aggregator — openrouter / deepseek / groq / xai /
  // … — and the local engines) MUST carry its own base URL. If it got dropped
  // upstream the openai client silently defaults to api.openai.com, which would
  // send THIS provider's key (e.g. an `sk-or-…` OpenRouter key) to OpenAI — a
  // credential leak that OpenAI rejects with a misleading "Incorrect API key"
  // error. The renderer resolver fills the base URL from the provider catalog;
  // this is the sidecar's last line of defence. Refuse with a clear, actionable
  // message instead of leaking the key. (The base-URL-less case above already
  // returned, so reaching here means a key IS present but the URL is wrong.)
  if (protocol === "openai" && isMisroutedToOpenAi(provider, resolvedCreds.baseURL)) {
    emit({
      type: "session_ended",
      sessionId,
      error: `provider "${provider}" has no base URL, so the request would go to api.openai.com with the "${provider}" API key — refused to avoid leaking the key to OpenAI. This usually means the app is running an older build: restart it (desktop: quit and relaunch; web: hard-reload) to pick up the provider fix, or set the "${provider}" base URL in Settings → Providers.`,
    })
    return null
  }

  const sdkSessionId = randomUUID()

  // Model-facing tool names that had to be renamed for the provider
  // (`ocr.extract` → `ocr_extract`), filled in once the tools map is sealed.
  // The adapter maps them back so the renderer keeps seeing cognia names.
  /** @type {Map<string, string>} */
  const toolNameAliases = new Map<string, string>()
  const adapter = createEventAdapter({
    sessionId,
    sdkSessionId,
    model,
    provider,
    startedAt: Date.now(),
    toolNameAliases,
  })

  // For multi-turn support we accumulate user messages in a queue. A new
  // `streamText` is started on every push so each turn is a fresh request.
  // The first turn fires immediately.
  const inputStream = makeInputStream<Prompt>()
  let active = false
  // Per-TURN interrupt flag: `interrupt()` sets it to stop the in-flight turn,
  // and `runTurn()` resets it at the head of the next turn. Distinct from
  // `closing` so that interrupting a turn does NOT retire the (multi-turn)
  // session — the next user message continues with the accumulated context.
  let cancelled = false
  // Per-SESSION close flag: set only by `closeInput()` (explicit `close`). Once
  // true the dispatch loop stops and no further turns run.
  let closing = false
  // AbortController for the in-flight turn. `interrupt()` aborts it so the
  // provider HTTP request actually cancels (the `cancelled` flag alone only
  // stopped consuming the stream AFTER the call completed — it kept billing).
  /** @type {AbortController | null} */
  let activeAbortController: AbortController | null = null
  // Router + Fusion (ADR-0188): the ledger stamp for the NEXT turn. The session
  // outlives a single send, so each send hands its own stamp in (`setNextTurnLedger`
  // from `handleSend`); a turn without one is never gated.
  let nextTurnLedger = sendOptions.ledger ?? null
  // The paired device's execution context of the send behind the NEXT turn, or
  // undefined for a host-started send. Per turn like the stamp: a reservation
  // is answerable only by the device whose send raised it (ADR-0188 D25).
  let nextTurnRemoteContext: unknown = sendOptions.remoteExecutionContext
  /** @type {ReturnType<typeof createCallLedgerGate> | null} */
  let turnLedgerGate: CallLedgerGate | null = null
  // Distinct logical step ids for reserved calls outside the leg loop.
  let ledgerSideCalls = 0
  // Creds/params from the most recent turn — let a manual compaction (between
  // turns) reuse them for its one-shot summary call. A deferred manual request
  // (turn in flight) is parked here and honoured at the next turn's head.
  let lastCreds: AdapterCredentials = {}
  let lastModelParams = {}
  let manualCompactPending: { focus?: string } | null = null

  // Plugin tools round-trip through the renderer; claude-host resolves
  // `plugin_tool_response` against this Map (same contract as the Anthropic
  // path). Exposed on the returned session so the host can reach it.
  const pendingPluginToolCalls: PendingPluginToolCalls = new Map()
  // `{ type: "plugin" }` lifecycle hooks and the host's own plugin-hook seams
  // (compaction) round-trip through the renderer against this map; settled by
  // `claude-host.mjs` from the `plugin_hook_response` frame.
  const pendingPluginHookCalls: PendingPluginHooks = new Map()
  // Tool-permission approvals round-trip the same way (`permission_request` →
  // `permission_response`), resolved by claude-host against this Map.
  const pendingApprovals = new Map<string, PendingApproval>()
  // Tool-result reviews (plugin SDK PostToolUse rewrite) round-trip via
  // `tool_result_review` → `tool_result_decision`, resolved by claude-host
  // against this Map. Engaged only when `sendOptions.toolResultReviewEnabled`.
  const pendingToolResultReviews = new Map<string, { resolve(value: unknown): void }>()
  const toolResultReviewEnabled = sendOptions.toolResultReviewEnabled === true
  // Tools are stable for the session — build once, reuse across turns.
  /** @type {Record<string, unknown> | undefined} */
  let toolsCache: ToolSet | undefined
  let toolSearchController: ReturnType<typeof createAiSdkToolSearchController> = null
  // Doom-loop guards owned by this session (the tool gate's + the MCP gate's).
  // The tools map is built once, so the guards live for the whole multi-turn
  // session; reset them per turn so a legitimate identical call repeated ACROSS
  // turns (e.g. reading the same config at the start of each turn) doesn't trip
  // the threshold — the Anthropic path resets implicitly via a fresh guard per
  // `query()`.
  /** @type {Array<{ reset: () => void }>} */
  const doomGuards: { reset(): void }[] = []
  // Teardown for external MCP-server connections, set when they're opened.
  /** @type {(() => Promise<void>) | null} */
  let mcpClose: (() => Promise<void>) | null = null
  const toolSession = createToolSessionContext({ sendOptions, log, hostRpc, sessionId })

  // Agentic step budget for the WHOLE user turn. The turn runs a manual agent
  // loop (see `runTurn`) of `STEP_CHUNK`-step legs until the model naturally
  // stops or this budget is exhausted — a runaway backstop, NOT a task-length
  // limit. Precedence: an explicit `maxTurns` (subagents / `/goal` set a
  // deliberate small budget) wins; otherwise the configurable `aiSdkMaxSteps`;
  // otherwise 256. This replaces a hard 16-step single leg that silently stopped
  // any multi-tool task on every non-Anthropic provider — the Anthropic Agent
  // SDK loops unbounded, so the two channels were badly asymmetric.
  // Per-leg agentic step cap. Each `streamText` leg re-sends the whole growing
  // conversation, so a LARGER chunk means fewer legs → fewer full re-sends for a
  // long tool-using turn (less prompt-token overhead). The trade-off: a larger
  // chunk runs more steps between the per-leg `maybeCompact` check, so the window
  // is inspected less often within a turn — keep the default modest (16) and let
  // callers opt into a larger chunk via `aiSdkStepChunk`. Parallel tool calls
  // within a single step are handled natively by AI SDK (multiple tool-calls per
  // step execute concurrently), so this only bounds sequential tool-use depth.
  const STEP_CHUNK = resolveStepChunk(sendOptions.aiSdkStepChunk)
  const baseStepsBudget =
    typeof sendOptions.maxTurns === "number" && sendOptions.maxTurns > 0
      ? sendOptions.maxTurns
      : typeof sendOptions.aiSdkMaxSteps === "number" && sendOptions.aiSdkMaxSteps > 0
        ? sendOptions.aiSdkMaxSteps
        : 256
  // A routed `@agent` clamps the loop by its own `maxTurns` (parity with the
  // Anthropic Agent SDK). Clamp DOWN only — never widen the turn's budget.
  const maxStepsBudget = agentMaxTurns ? Math.min(baseStepsBudget, agentMaxTurns) : baseStepsBudget

  function flushAdapter(events: unknown[]) {
    for (const e of events) {
      emit({ type: "event", sessionId, event: e })
    }
  }

  const reviewToolOutput = createOutputReviewer({
    pending: pendingToolResultReviews,
    sessionId,
    emit,
    isStopped: () => closing || cancelled,
    remoteExecutionContext: sendOptions.remoteExecutionContext,
  })

  // Build a flat conversation from accumulated user/assistant turns.
  // `systemPrompt` and `appendSystemPrompt` CONCATENATE (matching the
  // Anthropic path, where append extends the system prompt) — previously
  // append was silently dropped whenever a base system prompt was set,
  // losing A2UI/goal/plan/brief instructions on the non-Anthropic path.
  /** @type {Array<{ role: "user"|"assistant"|"system", content: any }>} */
  const conversation: ConversationMessage[] = []
  const systemParts = [
    // `@agent` overlay (if any) leads so the subagent's identity frames the turn,
    // with the app's base + appended sections kept beneath it.
    agentSystemPrompt,
    sendOptions.systemPrompt,
    sendOptions.appendSystemPrompt,
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0)
  if (
    systemParts.length > 0 &&
    protocol === "anthropic" &&
    sendOptions.cacheOptimizationEnabled === true
  ) {
    // Cache optimization + anthropic protocol: put an explicit cacheControl
    // breakpoint on the stable base prefix.
    conversation.push({
      role: "system",
      content: systemParts[0],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    })
    // The remaining part is `appendSystemPrompt`. When the renderer declared a
    // per-turn dynamic tail (`dynamicSystemPrompt` = twin RAG chunks + memory
    // recall, the exact suffix of appendSystemPrompt), split it off: cache the
    // stable head with a SECOND breakpoint and leave only the tail uncached, so
    // the cache write never churns on the per-turn sections. Without a declared
    // tail the append stays uncached exactly as before (back-compat).
    const dyn =
      typeof sendOptions.dynamicSystemPrompt === "string" ? sendOptions.dynamicSystemPrompt : ""
    for (const part of systemParts.slice(1)) {
      if (dyn && part.length > dyn.length && part.endsWith(dyn)) {
        const stable = part.slice(0, part.length - dyn.length).replace(/\n+$/, "")
        if (stable) {
          conversation.push({
            role: "system",
            content: stable,
            providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
          })
        }
        conversation.push({ role: "system", content: dyn })
      } else {
        conversation.push({ role: "system", content: part })
      }
    }
  } else if (systemParts.length > 0) {
    conversation.push({ role: "system", content: systemParts.join("\n\n") })
  }

  if (Array.isArray(sendOptions.initialConversation)) {
    // Keep the freshly resolved system policy while restoring provider message
    // objects verbatim, including concurrent tool call ids and result outputs.
    conversation.push(
      ...sendOptions.initialConversation.filter((message) => message.role !== "system")
    )
  }

  function pushUserToConversation(content: Prompt) {
    if (typeof content === "string") {
      conversation.push({ role: "user", content })
    } else if (Array.isArray(content)) {
      // Multimodal content blocks arrive in the Anthropic agent-SDK shape
      // (`{ type:'image', source:{ type:'base64', media_type, data } }`) because
      // the composer targets the native Anthropic path. AI SDK 7 wants a single
      // canonical `{ type:'file', mediaType, data }` part (images are just files
      // with an image media type), so the blocks MUST be converted here —
      // otherwise streamText drops every image and non-Anthropic providers
      // (OpenAI/Gemini/Mistral/…) see text only.
      conversation.push({ role: "user", content: toAiSdkUserContent(content) })
    }
  }

  // Real input-token count from the previous turn's usage; drives the
  // compaction trigger (same signal the Anthropic SDK auto-compacts on).
  let lastInputTokens = 0
  // Highest frozen-summary version spliced into `conversation` this session.
  // The summaries themselves live in `conversation` (re-detected via
  // `summaryVersion`); this is a monotonic hint for the next version number.
  let frozenSummaryVersion = 0

  const maybeCompact = createCompactor({
    state: {
      get model() {
        return model
      },
      get lastInputTokens() {
        return lastInputTokens
      },
      set lastInputTokens(value) {
        lastInputTokens = value
      },
      get frozenSummaryVersion() {
        return frozenSummaryVersion
      },
      set frozenSummaryVersion(value) {
        frozenSummaryVersion = value
      },
      get ledgerSideCalls() {
        return ledgerSideCalls
      },
      set ledgerSideCalls(value) {
        ledgerSideCalls = value
      },
      get turnLedgerGate() {
        return turnLedgerGate
      },
      get activeAbortController() {
        return activeAbortController
      },
    },
    conversation,
    sendOptions,
    provider,
    sessionId,
    sdkSessionId,
    hostRpc,
    emit,
    log,
    protocolAdapter,
    pendingProtocolExecs,
    pendingPluginHookCalls,
    streamTextOverride,
    isCancelled: () => cancelled,
  })

  // Controls also cancel queued manual requests, which have not created a
  // compactor job yet and therefore cannot be stopped by its AbortController.
  let compactionGeneration = 0
  function invalidateCompaction() {
    compactionGeneration++
    manualCompactPending = null
    maybeCompact.invalidate()
  }

  let idleCompaction: Promise<void> | null = null

  async function runTurn() {
    // A user send can arrive while an idle manual compaction is awaiting its
    // provider. Publish that result before starting this turn's model stream.
    while (idleCompaction) await idleCompaction
    if (active || closing) return
    // Clear any leftover interrupt from a previous turn so this turn streams.
    cancelled = false
    active = true
    // Router + Fusion call gate for THIS turn. Inactive (and invisible) unless
    // the send carried a ledger stamp.
    const ledgerGate = createCallLedgerGate({
      ledger: nextTurnLedger,
      sessionId,
      emit,
      log,
      remoteExecutionContext: nextTurnRemoteContext,
    })
    nextTurnLedger = null
    nextTurnRemoteContext = undefined
    turnLedgerGate = ledgerGate
    const settleTurnCompaction = async () => {
      const settled = maybeCompact.settle()
      // Release any unanswered background reservation before awaiting it.
      ledgerGate.drain("turn_ended")
      await settled
    }
    /** @type {{ attemptId: string, attemptNo: number, logicalStepId: string } | null} */
    let openLedgerAttempt: { attemptId: string; attemptNo: number; logicalStepId: string } | null =
      null
    const reportOpenAttempt = (result: Omit<CallReport, "logicalStepId">) => {
      if (!openLedgerAttempt) return
      ledgerGate.report({ ...openLedgerAttempt, ...result })
      openLedgerAttempt = null
    }
    // Usage normally arrives on the closing `result.usage` promise. If the user
    // interrupts, that promise commonly rejects and used to erase every token
    // already billed by completed steps. Keep a per-step fallback while the
    // stream is alive, then emit it before the clean interrupted session end.
    let accInputTokens = 0
    let accOutputTokens = 0
    let lastUsageForFinish: Record<string, unknown> | null = null
    let currentLegStepInputTokens = 0
    let currentLegStepOutputTokens = 0
    let currentLegLastInputTokens = 0
    let currentLegStepUsage: Record<string, unknown> | null = null
    const recordCompletedStepUsage = (value: unknown) => {
      const usage = record(value)
      if (!usage || typeof usage !== "object") return
      const input = usage.inputTokens ?? usage.promptTokens
      const output = usage.outputTokens ?? usage.completionTokens
      if (typeof input === "number" && input > 0) {
        currentLegStepInputTokens += input
        currentLegLastInputTokens = input
      }
      if (typeof output === "number" && output > 0) currentLegStepOutputTokens += output
      currentLegStepUsage = usage
    }
    const finishUsageSnapshot = () => {
      const inputTokens = accInputTokens + currentLegStepInputTokens
      const outputTokens = accOutputTokens + currentLegStepOutputTokens
      const base = lastUsageForFinish ?? currentLegStepUsage
      if (!base && inputTokens <= 0 && outputTokens <= 0) return undefined
      return {
        ...(base ?? {}),
        ...(inputTokens > 0 ? { inputTokens } : {}),
        ...(outputTokens > 0 ? { outputTokens } : {}),
        ...(currentLegLastInputTokens > 0 || lastInputTokens > 0
          ? { contextInputTokens: currentLegLastInputTokens || lastInputTokens }
          : {}),
      }
    }
    // Reset per-turn so identical-but-legitimate calls repeated across turns
    // don't trip the doom-loop threshold (the guards persist with the cached
    // tools map). Empty on turn 1 — the build below populates them.
    for (const g of doomGuards) g.reset()
    // NB: the event adapter's turn-scoped buffers are reset at the top of EACH
    // agent-loop leg below (so every leg renders as a fresh content block, and
    // turn N+1 never re-emits turn N's reply — the "duplicate output" bug). The
    // adapter is created once per session, so `init` is emitted only once.
    try {
      const creds = sendOptions.providerCredentials ?? {}
      // `modelParams` carries the provider's configured sampling settings
      // (temperature, maxOutputTokens, topP, topK, penalties, stopSequences,
      // seed, maxRetries) in AI SDK v6 call-option naming. Spread them so the
      // turn honours the user's provider config instead of silently dropping
      // every knob. Undefined keys are omitted by the builder upstream.
      const modelParams = sendOptions.modelParams ?? {}
      lastCreds = creds
      lastModelParams = modelParams

      // Created BEFORE any compaction so `interrupt()` can abort the one-shot
      // summary call too (previously the controller was created after
      // `maybeCompact`, leaving the summary request un-abortable).
      const abortController = new AbortController()
      activeAbortController = abortController

      // Honour a manual `/compact` that arrived mid-turn (deferred so we never
      // run two summary calls concurrently), then the automatic threshold.
      if (manualCompactPending) {
        const { focus } = manualCompactPending
        manualCompactPending = null
        await maybeCompact(creds, modelParams, { force: true, focus })
      }

      // Build native AI SDK tools (built-in + plugin) once. Lazy-imported so
      // the bridge (and its `ai` dependency) doesn't load for tool-less turns.
      if (toolsCache === undefined) {
        if (agentScopedSendOptions.toolSurface === "none") {
          // Final dispatcher contract: a disabled tool surface must stay empty
          // even when stale/global MCP or ToolSearch settings survive upstream.
          toolsCache = {}
        } else {
          const { buildAiSdkTools } = await import("../../tools/adapters/ai-sdk.ts")
          const { createDoomLoopGuard } = await import("../../policy/doom-loop.ts")
          // Own the tool gate's guard here so it can be reset per turn (F1).
          const toolDoomGuard = createDoomLoopGuard()
          doomGuards.push(toolDoomGuard)
          toolsCache = buildAiSdkTools({
            // A routed `@agent` narrows the built-in tool allowlist to its own
            // tools and unions its deny-list on top (same allowlist mechanism
            // characters / skills / modes use). `disallowedTools` (deny /
            // restricted mode) is checked separately and still wins.
            sendOptions: agentScopedSendOptions,
            emit,
            pendingApprovals,
            pendingPluginToolCalls,
            ...toolSession.toolContext(),
            doomGuard: toolDoomGuard,
            // PostToolUse rewrite at the execute layer (opt-in) — see
            // `reviewToolOutput` above.
            ...(toolResultReviewEnabled ? { reviewToolOutput } : {}),
          })

          // External MCP servers (parity with the Anthropic path, which passes
          // `mcpServers` to the agent SDK). `streamText` has no MCP concept, so
          // we connect the user's servers here and merge their (namespaced,
          // gated) tools. Connect once per session; close on teardown. A failure
          // logs and degrades to the built-in/plugin tools rather than breaking
          // the turn.
          if (sendOptions.mcpServers && Object.keys(sendOptions.mcpServers).length > 0) {
            try {
              const buildAiSdkMcpTools =
                buildMcpToolsOverride ??
                (await import("../../mcp/client/tools.ts")).buildAiSdkMcpTools
              const { createToolPermissionGate } =
                await import("../../policy/permission/ai-sdk-gate.ts")
              // Own the MCP gate's guard here too so it resets per turn (F1).
              const mcpDoomGuard = createDoomLoopGuard()
              doomGuards.push(mcpDoomGuard)
              const mcpGate = createToolPermissionGate({
                emit,
                sessionId,
                pendingApprovals,
                sendOptions: agentScopedSendOptions,
                doomGuard: mcpDoomGuard,
              })
              const mcp = await buildAiSdkMcpTools({
                mcpServers: sendOptions.mcpServers,
                gate: async (...args) => record(await mcpGate(...args)),
                ...(toolResultReviewEnabled ? { reviewToolOutput } : {}),
                // A routed `@agent` narrows the allowlist to its own tools and
                // unions its deny-list (parity with the built-in tool path above).
                allowedTools: agentScopedSendOptions.allowedTools,
                disallowedTools: agentScopedSendOptions.disallowedTools,
                log,
                // Surface each server's stderr + connect/tool diagnostics as
                // `mcp_log` events for the renderer's MCP log panel (the ai-sdk
                // path previously logged these only to the sidecar's own stderr).
                emitMcpLog: (entry) =>
                  emit({ ...buildMcpLogEvent({ sessionId, ts: Date.now(), ...entry }) }),
              })
              mcpClose = mcp.close
              if (Object.keys(mcp.tools).length > 0) {
                const merged = { ...toolsCache, ...mcp.tools }
                // Re-sort so the tools map serializes identically across turns
                // (prompt-cache prefix stability), matching buildAiSdkTools.
                toolsCache = Object.fromEntries(
                  Object.keys(merged)
                    .sort()
                    .map((k) => [k, merged[k]])
                ) as ToolSet
              }
            } catch (err) {
              log(
                "warn",
                `external MCP setup failed, continuing without it: ${errorToMessage(err)}`
              )
            }
          }

          // Providers validate function names against `^[a-zA-Z0-9_-]{1,64}$`.
          // A plugin tool such as `ocr.extract` or an MCP tool with a slash
          // would fail the whole request, so rename at the boundary and keep
          // the alias table for the adapter (renderer-facing names) and
          // ToolSearch (`select:` by cognia name). Done on the sealed map so
          // every source (built-in, plugin, external MCP) is covered once.
          {
            const { sanitizeToolMap } = await import("../../policy/tool-catalog/model-names.ts")
            const renamed = sanitizeToolMap(toolsCache)
            toolsCache = renamed.tools
            toolNameAliases.clear()
            for (const [modelName, original] of renamed.aliases) {
              toolNameAliases.set(modelName, original)
            }
            if (renamed.aliases.size > 0) {
              const pairs = [...renamed.aliases]
                .map(([modelName, original]) => `${original} → ${modelName}`)
                .join(", ")
              log("info", `renamed ${renamed.aliases.size} tool name(s) for the provider: ${pairs}`)
            }
          }

          // Cross-provider deferred loading. The Anthropic Agent SDK handles
          // ToolSearch/alwaysLoad natively; AI SDK providers need an explicit
          // ToolSearch tool plus prepareStep(activeTools). Build it only after
          // built-in, plugin, and external MCP tools have been permission-filtered
          // and merged, so discovery can only activate tools the session already
          // owns. The controller persists for this sidecar session, retaining
          // discovered tools across manual-loop legs and user turns.
          if (agentScopedSendOptions.toolSearchEnabled === true) {
            const { createAiSdkToolSearchController } =
              await import("../../tools/adapters/ai-sdk-tool-search.ts")
            toolSearchController = createAiSdkToolSearchController({
              tools: toolsCache,
              sendOptions: agentScopedSendOptions,
              toolNameAliases,
            })
            if (toolSearchController) toolsCache = toolSearchController.tools
          }
        }
      }

      // ── Manual agent loop ────────────────────────────────────────────────
      // The AI SDK-blessed pattern (docs: "manual agent loop"): each `streamText`
      // leg runs up to `STEP_CHUNK` agentic steps, then we inspect the leg's
      // `finishReason`. `"tool-calls"` means the model stopped ONLY because it hit
      // the per-leg step cap while still wanting to call tools → continue the loop
      // (re-stream the accumulated conversation). Any other finish reason
      // ("stop"/"length"/unknown) is a genuine end. Previously the turn ended
      // after a single 16-step leg, so any task needing more tool calls silently
      // stopped mid-flight on every non-Anthropic provider. We bound the whole
      // turn by `maxStepsBudget` as a runaway backstop and compact BETWEEN legs so
      // a long loop can't overflow the context window.
      let assistantText = ""
      let stepsUsed = 0
      let turnError = null
      let cappedWhileBusy = false
      // Router + Fusion: the logical call index (a transport retry keeps it) and
      // a refusal that ended the turn.
      let ledgerLegIndex = 0
      let ledgerRefusal = null
      // Non-ledger calls get the same bounded pre-output retry as reserved
      // transport attempts (opencode v1.18.17: capped retries + jitter).
      let transportRetries = 0
      let overflowRecoveryAttempted = false
      let turnProducedOutput = false
      // Unknown finishReasons keep the loop going — bounded so a provider that
      // always ends "other" can't spin the turn forever (opencode v1.18.21).
      let unknownFinishContinues = 0

      while (true) {
        currentLegStepInputTokens = 0
        currentLegStepOutputTokens = 0
        currentLegLastInputTokens = 0
        currentLegStepUsage = null
        // Fresh content block per leg (new messageId) so the renderer keeps each
        // leg's text/tool calls distinct instead of merging them into one block.
        adapter.reset()

        // Publish prepared summaries only between legs. The soft threshold
        // prepares alongside the next model call; the hard threshold waits.
        await maybeCompact(creds, modelParams)

        // Enforce the tool-call ↔ tool-result pairing invariant before sending.
        // An interrupt that aborts a leg mid-tool-call, or a count-based
        // compaction tail slice that cuts between an assistant tool-call and its
        // tool result, can leave `conversation` with a dangling call or an orphan
        // tool message — which DeepSeek/OpenAI reject ("Messages with role 'tool'
        // must be a response to a preceding message with 'tool_calls'"). The
        // sanitizer is identity-preserving on a well-formed history, so this is a
        // no-op except on the corrupted-by-interrupt/compaction case.
        let messagesForSend = sanitizeToolMessagePairs(conversation)
        // Cache the conversation prefix: tag the LAST message with an ephemeral
        // breakpoint so Anthropic caches the whole history up to here and only the
        // next turn's delta is fresh. A shallow copy keeps the persistent
        // `conversation` array clean (no breakpoints accumulating turn over turn).
        // Anthropic-protocol only; other providers cache the prefix automatically.
        // System breakpoints (≤2) + this one stay within Anthropic's 4-breakpoint cap.
        if (
          protocol === "anthropic" &&
          sendOptions.cacheOptimizationEnabled === true &&
          messagesForSend.length > 0
        ) {
          const lastIdx = messagesForSend.length - 1
          const last = messagesForSend[lastIdx]!
          messagesForSend = [
            ...messagesForSend.slice(0, lastIdx),
            {
              ...last,
              providerOptions: {
                ...record(last.providerOptions),
                anthropic: {
                  ...record(record(last.providerOptions).anthropic),
                  cacheControl: { type: "ephemeral" },
                },
              },
            },
          ]
        }

        // Never exceed the remaining turn budget; always allow at least 1 step.
        // A ledgered turn runs exactly ONE model call per leg, so every call is
        // reserved before it is sent.
        const perLegCap = ledgerGate.active
          ? 1
          : Math.max(1, Math.min(STEP_CHUNK, maxStepsBudget - stepsUsed))

        if (ledgerGate.active) {
          const logicalStepId = `leg:${ledgerLegIndex}`
          const reservation = await ledgerGate.reserve({
            kind: "call",
            logicalStepId,
            estimatedInputTokens: Math.max(
              lastInputTokens,
              estimatePromptTokens(messagesForSend) + Object.keys(toolsCache ?? {}).length * 200
            ),
            maxOutputTokens:
              typeof modelParams.maxOutputTokens === "number" ? modelParams.maxOutputTokens : null,
          })
          if (reservation.decision === "refused") {
            // An interrupt drains pending reservations as refused; that is the
            // user stopping the turn, not a budget refusal.
            if (!cancelled) ledgerRefusal = reservation
            break
          }
          if (reservation.decision === "granted" && reservation.attemptId) {
            openLedgerAttempt = {
              attemptId: reservation.attemptId,
              attemptNo: reservation.attemptNo ?? 1,
              logicalStepId,
            }
          }
        }

        const result = await protocolAdapter.start({
          sessionId,
          traceId: sendOptions.traceId,
          traceparent: sendOptions.traceparent,
          surface: "chat",
          runId: sendOptions.execution?.identity?.runId,
          turnId: sendOptions.turnId,
          attemptId: sendOptions.execution?.identity?.attemptId,
          projectId: sendOptions.projectId,
          feature: "chat",
          promptComponentIds: sendOptions.execution?.composition?.presetId
            ? [`agent-preset:${sendOptions.execution.composition.presetId}`]
            : undefined,
          promptFingerprint: sendOptions.execution?.composition?.compositionDigest,
          model,
          messages: messagesForSend.map((message) => ({ ...message, content: message.content })),
          modelParams,
          tools: toolsCache,
          ...(toolSearchController ? { prepareStep: toolSearchController.prepareStep } : {}),
          maxSteps: perLegCap,
          credentials: creds,
          // The built-in provider id (NOT the protocol): the openai endpoint
          // decision and Codex's Responses-API fields are keyed on the id, since
          // a provider's host alone can't identify it behind a relay preset.
          providerId: provider,
          // Enable reasoning per provider — `effort` (thinking level) and
          // `maxThinkingTokens` (budget) were dropped here, so non-Anthropic
          // reasoning models ran with thinking off. The adapter maps these to
          // the right providerOptions block (or no-ops when not applicable).
          reasoning: {
            effort: sendOptions.effort,
            maxThinkingTokens: sendOptions.maxThinkingTokens,
          },
          // Break the agentic leg right after a step whose tool result carries an
          // image, so we can re-project it as a user message before the model
          // continues (providers that can't carry tool-result images otherwise
          // never see it). Omitted for Anthropic, which carries them natively.
          ...(projectToolImages
            ? {
                stopWhenExtra: (steps) => {
                  const last = Array.isArray(steps) ? steps[steps.length - 1] : null
                  return (
                    !!last &&
                    Array.isArray(last.toolResults) &&
                    last.toolResults.some((tr: unknown) => toolOutputHasImage(record(tr).output))
                  )
                },
              }
            : {}),
          abortSignal: abortController.signal,
          streamTextFn: streamTextOverride,
          // A reserved call is exactly one provider request: the SDK's own
          // transport retries would send more than the ledger admitted.
          ...(openLedgerAttempt ? { maxRetries: 0 } : {}),
        })

        let legText = ""
        let legProducedOutput = false
        // Capture a streamed error part. AI SDK v6 surfaces provider/auth/network
        // failures as a `{ type:"error", error }` part in `fullStream` (and only
        // console.errors them via the default onError) rather than throwing.
        let streamError: unknown = null
        // The closing `finish` part carries the leg's finishReason — the signal
        // that decides whether to continue the agent loop.
        let finishReason: unknown = null
        try {
          // Idle-gap bound on the event stream (default 5 min, the provider
          // timeout the webview fetch wrapper applies too). `streamIdleTimeoutMs`
          // is a dispatch-level override so tests don't wait out the real bound.
          for await (const event of withIdleTimeout(
            result.fullStream,
            streamIdleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
          )) {
            const evt = record(event)
            if (cancelled) break
            if (evt?.type === "error") streamError = evt.error
            if (evt?.type === "finish") finishReason = evt.finishReason ?? finishReason
            if (evt?.type === "finish-step") {
              recordCompletedStepUsage(evt.usage ?? evt.totalUsage)
            }
            // NB: the PostToolUse review no longer intercepts here — it runs at
            // the tool EXECUTE layer (see `reviewToolOutput`), so tool-result
            // events already carry the reviewed output the model will see.
            const out = adapter.handle(evt)
            flushAdapter(out)
            if (evt?.type === "text-delta") {
              legText += evt.text ?? evt.textDelta ?? evt.delta ?? ""
            }
            if (
              evt?.type === "text-delta" ||
              evt?.type === "reasoning-delta" ||
              evt?.type === "tool-call" ||
              evt?.type === "tool-input-start"
            ) {
              legProducedOutput = true
              turnProducedOutput = true
            }
          }
        } catch (err) {
          // The watchdog's idle-timeout is routed through the normal error
          // classification (it lands as timeout_after_send). Anything else the
          // iterator throws keeps propagating to the turn-level catch — the
          // cancellation path there must not be re-classified as a stream error.
          if (err instanceof StreamIdleTimeoutError) {
            if (!streamError) streamError = err
          } else {
            throw err
          }
        }
        // Seal this leg's streamed text/reasoning deltas into the canonical full
        // `assistant` snapshot (the deltas above are `stream_event` previews). The
        // renderer replaces the in-progress preview by id. No-op for a leg that
        // produced only tool results (its boundary snapshots already sealed it).
        flushAdapter(adapter.sealAssistant())
        assistantText += legText

        // A call the provider refused before producing anything may be retried.
        // Under Router + Fusion the failed reserved attempt is reported and a
        // NEW reservation is used; an unreserved call retries within the same
        // bounded transport budget. In both cases a call that was sent and
        // simply never answered (`timeout_after_send`, e.g. the stream watchdog
        // or a socket hangup) is still booked as UNKNOWN — it is retried, but
        // never assumed free.
        if (streamError && !legProducedOutput && !cancelled) {
          const contextOverflow =
            classifyProviderError(errorToMessage(streamError)) === "context-window-exceeded"
          const errorClass = contextOverflow ? "invalid_request" : classifyCallError(streamError)
          const retryable = !contextOverflow && isRetryableBeforeOutput(errorClass)
          if (
            contextOverflow &&
            !turnProducedOutput &&
            !overflowRecoveryAttempted &&
            sendOptions.compaction?.enabled !== false &&
            sendOptions.compaction?.trigger !== "manual"
          ) {
            overflowRecoveryAttempted = true
            reportOpenAttempt({ status: "failed", errorClass, reason: errorToMessage(streamError) })
            const beforeTokens = estimatePromptTokens(conversation)
            await maybeCompact(creds, modelParams, { force: true, trigger: "auto" })
            // A refused first call has no output or tools to replay. Retry only
            // once, with a fresh ledger reservation, after a real reduction.
            if (!cancelled && !closing && estimatePromptTokens(conversation) < beforeTokens)
              continue
          }
          if (openLedgerAttempt) {
            const attemptNo = openLedgerAttempt.attemptNo
            reportOpenAttempt({
              status: errorClass === "timeout_after_send" ? "unknown" : "failed",
              errorClass,
              reason: errorToMessage(streamError),
            })
            if (retryable && attemptNo < ledgerGate.transportAttempts) {
              const { retryAfterMs } = extractHttpErrorMeta(streamError)
              await new Promise((resolve) =>
                setTimeout(resolve, Math.min(Math.max(retryAfterMs ?? 1000, 0), 30_000))
              )
              if (!cancelled) continue
            }
          } else if (retryable && transportRetries < MAX_TRANSPORT_RETRIES) {
            transportRetries += 1
            const { retryAfterMs } = extractHttpErrorMeta(streamError)
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(Math.max(retryAfterMs ?? 1000, 0), 30_000))
            )
            if (!cancelled) continue
          }
        }

        // A streamed error before ANY text in the whole turn is a failed turn —
        // report the real provider message instead of a silent empty
        // `session_ended` (which the loop maps to "no assistant text"). Returning
        // here also skips the `result.response`/`result.usage` reads below, whose
        // getters reject on a hard error.
        if (streamError && !assistantText && !cancelled) {
          const msg = errorToMessage(streamError)
          // Output was produced (tool calls) but no bill arrived: sent, outcome
          // unknown. Never booked as free.
          reportOpenAttempt({
            status: "unknown",
            errorClass: classifyCallError(streamError),
            reason: msg,
          })
          await settleTurnCompaction()
          emit({
            type: "session_ended",
            sessionId,
            error: msg,
            // Forward the real HTTP status + Retry-After from the ai-sdk
            // APICallError so the renderer classifies + cools down off
            // authoritative data, not string-matching.
            ...extractHttpErrorMeta(streamError),
          })
          return
        }
        // An error after we already have content from this/an earlier leg: stop
        // the loop but keep what we produced (the clean `finish` below ends it).
        if (streamError) turnError = streamError

        // Persist the leg into conversation history. When the SDK exposes the
        // full model message list (assistant text + tool calls + tool results),
        // prefer it so multi-turn context keeps tool history; otherwise fall back
        // to the leg's accumulated assistant text.
        //
        // NB: read each AI SDK result getter EXACTLY ONCE into a local. `result
        // .response` / `result.usage` are getters that return a fresh promise per
        // access; on a partial-error turn that promise rejects, so a throwaway
        // access in a `x ? await x : …` truthiness check would leave an unawaited
        // rejecting promise → an unhandled rejection that crashes the sidecar.
        let respMessages = null
        try {
          // AI SDK 7 moved model messages out of response metadata. Read the
          // dedicated getter once; older adapters retain response.messages.
          const messagePromise = result.responseMessages
          if (messagePromise !== undefined) {
            const messages = await messagePromise
            if (Array.isArray(messages)) respMessages = messages
          } else {
            const resp = await result.response
            if (resp && Array.isArray(resp.messages)) respMessages = resp.messages
          }
        } catch {
          respMessages = null
        }
        // True only for a leg that produced at least one tool-result image we
        // re-projected as a user message — used below to force one more leg so
        // the model actually gets to see it (even if it finished this leg).
        let injectedToolImages = false
        if (respMessages && respMessages.length > 0) {
          let toPush = stripReasoningParts(respMessages)
          if (projectToolImages) {
            const { images, sanitized } = projectToolResultImages(toPush)
            toPush = sanitized
            conversation.push(...toPush)
            if (images.length > 0) {
              injectedToolImages = true
              conversation.push({
                role: "user",
                content: [
                  { type: "text", text: "Image(s) returned by the tool call(s) above:" },
                  ...images,
                ],
              })
            }
          } else {
            conversation.push(...toPush)
          }
        } else if (legText) {
          conversation.push({ role: "assistant", content: legText })
        }
        const usageResult = result.usage
        const usageValue = usageResult ? await Promise.resolve(usageResult).catch(() => null) : null
        const usage = usageValue ? record(usageValue) : null
        // Record the real prompt size so the next leg/turn can decide whether to
        // compact. AI SDK v6 reports `inputTokens`; older shapes use `promptTokens`.
        if (usage) {
          const inTok = usage.inputTokens ?? usage.promptTokens
          if (typeof inTok === "number" && inTok > 0) {
            lastInputTokens = inTok
            accInputTokens += inTok
          }
          const outTok = usage.outputTokens ?? usage.completionTokens
          if (typeof outTok === "number" && outTok > 0) accOutputTokens += outTok
          lastUsageForFinish = usage
          // The resolved leg usage is authoritative and already includes the
          // completed steps observed above; clear the fallback to avoid counting
          // both paths on a normal completion.
          currentLegStepInputTokens = 0
          currentLegStepOutputTokens = 0
          currentLegLastInputTokens = 0
          currentLegStepUsage = null
        }

        if (openLedgerAttempt) {
          const rawUsage = rawUsageFromAiSdk(usage)
          const clean = !cancelled && !streamError
          let providerRequestId = null
          if (clean) {
            try {
              const id = record(await result.response).id
              providerRequestId = typeof id === "string" ? id : null
            } catch {
              providerRequestId = null
            }
          }
          reportOpenAttempt({
            // Interrupted or broken mid-stream: booked from its bill when the
            // provider sent one, otherwise UNKNOWN (sent, bill never seen).
            status: clean ? "succeeded" : rawUsage ? "failed" : "unknown",
            usage: rawUsage ?? undefined,
            providerRequestId,
            ...(finishReason
              ? {
                  finishReason:
                    finishReason === "tool-calls"
                      ? "tool_calls"
                      : finishReason === "length"
                        ? "length"
                        : "stop",
                }
              : {}),
            ...(streamError
              ? { errorClass: classifyCallError(streamError), reason: errorToMessage(streamError) }
              : {}),
            ...(cancelled && !rawUsage ? { reason: "cancelled_mid_stream" } : {}),
          })
          ledgerLegIndex += 1
        }

        if (cancelled || turnError) break

        // How many steps this leg actually ran. A leg cut short by `stopWhenExtra`
        // (a tool image) may run far fewer than `perLegCap`; charging the whole
        // cap would burn the turn budget on every image. Prefer the real count.
        let legStepsRun = 0
        let legStepsRead = true
        try {
          const steps = await result.steps
          if (Array.isArray(steps)) legStepsRun = steps.length
        } catch {
          // The `steps` getter rejects on a partial-error leg. Don't trust 0.
          legStepsRead = false
        }
        const legStepsCharged = chargeLegSteps({ legStepsRead, legStepsRun, perLegCap })

        // Continue the agent loop when the model stopped because it hit the
        // per-leg step cap with more tool calls pending, OR when we cut the leg
        // short to re-project a tool image (the model must see it next), OR when
        // the leg ended on a finishReason the SDK can't map — opencode v1.18.21
        // found providers whose novel finish values silently truncate a reply;
        // the leg's messages were already appended to `conversation` above, so
        // continuing picks up where the truncated answer left off. The unknown
        // branch requires FRESH output — an empty leg means the model is done
        // (or stuck), and continuing would just burn requests. Anything else
        // ends the turn here.
        const unknownFinish = finishReason === "unknown" || finishReason === "other"
        if (
          finishReason === "tool-calls" ||
          injectedToolImages ||
          (unknownFinish &&
            legProducedOutput &&
            unknownFinishContinues < MAX_UNKNOWN_FINISH_CONTINUES)
        ) {
          unknownFinishContinues = unknownFinish ? unknownFinishContinues + 1 : 0
          stepsUsed += legStepsCharged
          if (stepsUsed >= maxStepsBudget) {
            cappedWhileBusy = true
            break
          }
          continue
        }
        break
      }

      if (cappedWhileBusy) {
        // Never stop silently at the budget: tell the user the turn paused at the
        // safety cap and that another message resumes the same accumulated context.
        const note = `\n\n_(Reached the ${maxStepsBudget}-step agentic safety cap for this turn — send another message to continue.)_`
        flushAdapter(adapter.handle({ type: "text-delta", text: note }))
        // Seal the appended note as the canonical assistant snapshot (the line
        // above only streamed it as a `stream_event` delta).
        flushAdapter(adapter.sealAssistant())
        assistantText += note
      }

      // Trailing `result` reports the whole turn's summed usage (all legs) — the
      // correct cumulative-billing figure. But `inputTokens` summed across legs
      // over-counts the CONTEXT WINDOW (each leg re-sends the whole growing
      // prompt), so we also surface the LAST leg's prompt size separately: that
      // is what actually occupies the window after the turn. The renderer's
      // window math reads `contextInputTokens`; cost/session totals keep using
      // the summed `inputTokens`.
      // Report aborted background side calls before announcing terminal state.
      await settleTurnCompaction()
      const finishUsage = finishUsageSnapshot()
      const finishEvents = adapter.finish({ usage: finishUsage })
      flushAdapter(finishEvents)
      if (ledgerRefusal) {
        // Router + Fusion refused the next call (budget, limit, deadline). What
        // was produced so far is kept; the turn ends explicitly, never silently.
        emit({
          ...refusalSessionEnded(sessionId, ledgerRefusal),
          conversationSnapshot: conversation,
        })
      } else if (turnError && !cancelled) {
        // A provider error AFTER partial text already streamed (e.g. a 429 /
        // overloaded / connection-reset mid-reply). `finish` above closed the
        // content blocks so the partial is preserved, but we must still report
        // the error: a clean `session_ended` here would (a) skip the renderer's
        // routing fallback and breaker recording, and (b) present a truncated
        // reply as a successful turn. Symmetric with the pre-text error branch
        // above — forward the real HTTP status + Retry-After so the renderer
        // classifies off authoritative data.
        const msg = errorToMessage(turnError)
        emit({
          type: "session_ended",
          sessionId,
          error: msg,
          ...extractHttpErrorMeta(turnError),
        })
      } else {
        emit({ type: "session_ended", sessionId, conversationSnapshot: conversation })
      }
    } catch (err) {
      // A reserved call that threw instead of streaming: a configuration error
      // that never left the process is failed; anything else was possibly sent
      // and is UNKNOWN until reconciled.
      if (openLedgerAttempt) {
        const errorClass = classifyCallError(err, { aborted: cancelled })
        reportOpenAttempt({
          status:
            errorClass === "not_sent" || errorClass === "invalid_request" || errorClass === "auth"
              ? "failed"
              : "unknown",
          errorClass,
          reason: errorToMessage(err),
        })
      }
      await settleTurnCompaction()
      // An aborted turn (user interrupt) is a clean stop, not a failure —
      // streamText rejects with an AbortError once the signal fires.
      if (cancelled || record(err).name === "AbortError" || record(err).name === "TimeoutError") {
        const partialUsage = finishUsageSnapshot()
        if (partialUsage) flushAdapter(adapter.finish({ usage: partialUsage }))
        emit({ type: "session_ended", sessionId, conversationSnapshot: conversation })
      } else {
        emit({
          type: "session_ended",
          sessionId,
          error: errorToMessage(err),
          // Thrown (non-streamed) failures — buildModel errors, the variant
          // adapter's HTTP throw, getter rejections — carry status/Retry-After
          // too; forward it so the renderer's breaker doesn't fall back to
          // string matching. `{}` when the error has no HTTP metadata.
          ...extractHttpErrorMeta(err),
        })
      }
    } finally {
      await settleTurnCompaction()
      turnLedgerGate = null
      active = false
      activeAbortController = null
    }
  }

  // Initialization acknowledges restored context, including headless sends.
  // Keep this after synchronous setup/hydration and before any turn starts.
  emit({ type: "sdk_session_id", sessionId, sdkSessionId, runtimeAdapter: "ai-sdk" })

  // Wire the input-stream consumer: each pushed user message kicks off a turn.
  ;(async () => {
    pushUserToConversation(firstPrompt)
    await runTurn()
    for await (const next of inputStream.iterable) {
      // Stop ONLY on a real session close. An interrupt (`cancelled`) ends the
      // current turn but must not drop the next queued message — `runTurn`
      // resets `cancelled`, so the session keeps its accumulated context.
      if (closing) break
      pushUserToConversation(next)
      await runTurn()
    }
  })()
    .catch((err) => {
      log("error", `ai-sdk dispatch loop failed: ${errorToMessage(err)}`)
    })
    .finally(() => {
      // Session loop ended (input closed or fatal error) — kill any background
      // shells the agent left running so none outlive the session.
      invalidateCompaction()
      void toolSession.disposeProcesses()
      // Signal the host to retire this multi-turn session entry. Per-turn
      // `session_ended` events keep the session alive (so context accumulates);
      // this fires exactly once, when the loop genuinely ends.
      emit({ type: "session_closed", sessionId })
    })

  return {
    sdkSessionId,
    // Marks this dispatcher as a long-lived, multi-turn session: the host keeps
    // the session entry across per-turn `session_ended` events so the in-process
    // `conversation[]` (the only place context lives for non-Anthropic
    // providers) survives. Retired on `session_closed` / explicit close.
    multiTurn: true,
    q: {
      interrupt: async () => {
        cancelled = true
        invalidateCompaction()
        // Abort the in-flight provider request so it stops immediately instead
        // of running to completion while we ignore the rest of the stream.
        activeAbortController?.abort()
        // Resolve every pending round-trip as denied/aborted so the tool gate
        // (or plugin-tool / tool-result-review / protocol-adapter exec) doesn't
        // hang forever waiting for a renderer that already timed out.
        // `handleInterrupt` (claude-host.mjs) calls this BEFORE timeout, and
        // the renderer-side timeout calls it too — so a stuck session cleans up
        // regardless of which side triggers the interrupt first.
        drainPendingRoundTrips(
          {
            pendingApprovals,
            pendingPluginToolCalls,
            pendingPluginHookCalls,
            pendingToolResultReviews,
            pendingProtocolExecs,
            ledgerGate: turnLedgerGate ?? undefined,
            pluginToolFailure: { result: undefined, error: "interrupted" },
          },
          "interrupted",
          (requestId) =>
            emit({ type: "permission_interrupted", sessionId, requestId, reason: "interrupted" })
        )
      },
      /** True while a turn is in-flight (exposed for `handleSend` defense). */
      get active() {
        return active
      },
      get closed() {
        return closing
      },
      /**
       * Live model switch — the ai-sdk parity for the Anthropic SDK
       * `Query.setModel`. `claude-host.handleControl` invokes this for the
       * `setModel` control (driven by the renderer's model picker) so a
       * non-Anthropic, multi-turn session can change model WITHOUT a respawn
       * (which would drop the in-process conversation). Swaps the model the
       * NEXT turn streams with, keeps `sendOptions.model` consistent for any
       * later resolve / `restartReason`, and retags subsequent assistant
       * snapshots. An in-flight leg keeps the model it already started with; the
       * change lands on the next leg/turn. Empty / non-string is a no-op so a
       * bad control can never blank the model mid-session.
       *
       * @param {string} nextModel
       */
      setModel: (nextModel: string) => {
        if (typeof nextModel !== "string" || !nextModel) return
        invalidateCompaction()
        model = nextModel
        sendOptions.model = nextModel
        adapter.setModel(nextModel)
      },
    },
    pushUserMessage: (content: Prompt) => inputStream.push(content),
    /**
     * Router + Fusion: the ledger stamp of the send that is about to push its
     * prompt into this live session (`handleSend`). `undefined` / null means
     * the next turn is not gated. `remoteExecutionContext` is that send's paired
     * device context (absent for a host-started send).
     */
    setNextTurnLedger: (ledger: SendOptions["ledger"], remoteExecutionContext?: unknown) => {
      nextTurnLedger = ledger ?? null
      nextTurnRemoteContext = remoteExecutionContext
    },
    /** Resolve a pending reservation (`call_reserve_decision` from the renderer). */
    resolveCallReserve: (message: unknown) => turnLedgerGate?.resolveDecision(message) ?? false,
    // Manual compaction (renderer `/compact` or "Compact now"). When idle, run
    // the summary now reusing the last turn's creds; when a turn is in flight,
    // defer to the next turn's head so two summary calls never overlap.
    requestCompact: async (focus?: string) => {
      if (closing) return
      if (active) {
        manualCompactPending = { focus }
        return
      }
      const requestedGeneration = compactionGeneration
      const task = (async () => {
        if (idleCompaction) await idleCompaction
        if (closing || requestedGeneration !== compactionGeneration) return
        await maybeCompact(lastCreds, lastModelParams, { force: true, focus })
      })().catch((err) => log("warn", `manual compaction failed: ${errorToMessage(err)}`))
      idleCompaction = task
      await task
      if (idleCompaction === task) idleCompaction = null
    },
    // Undo a prior compaction by restoring the pre-compaction message snapshot.
    // Only valid while the session is live and idle (the renderer gates the UI
    // on "no intervening user turn"); a no-op while a turn is in flight.
    restoreConversation: (messages: ConversationMessage[]) => {
      if (closing || active) {
        log("warn", "restore ignored: session closing or turn in flight")
        return false
      }
      if (!Array.isArray(messages) || messages.length === 0) return false
      invalidateCompaction()
      conversation.splice(0, conversation.length, ...messages)
      lastInputTokens = 0
      frozenSummaryVersion = 0
      return true
    },
    closeInput: () => {
      // End the session: stop the loop (`closing`) and the in-flight turn
      // (`cancelled` + abort the provider request, so a stalled stream doesn't
      // block teardown).
      closing = true
      cancelled = true
      invalidateCompaction()
      activeAbortController?.abort()
      turnLedgerGate?.drain("session_closed")
      if (pendingProtocolExecs) {
        for (const [id, ch] of pendingProtocolExecs) {
          pendingProtocolExecs.delete(id)
          try {
            if (typeof ch.cancel === "function") ch.cancel("session closed")
            else ch.fail("session closed")
          } catch {
            /* defensive — the channel shape is adapter-defined */
          }
        }
      }
      inputStream.close()
      toolSession.disposeResolvers()
      // Disconnect any external MCP servers opened for this session.
      if (mcpClose) {
        const done = mcpClose
        mcpClose = null
        void done().catch((err) => log("warn", `mcp teardown failed: ${errorToMessage(err)}`))
      }
    },
    pendingApprovals,
    pendingPluginToolCalls,
    pendingPluginHookCalls,
    pendingProtocolExecs,
    pendingToolResultReviews,
    // Exposed for tests: the execute-layer PostToolUse review round-trip that
    // `buildAiSdkTools` / `buildAiSdkMcpTools` invoke before a tool's output
    // reaches the model.
    reviewToolOutput,
    sendOptions,
  }
}

// Exported for tests.
export const __testing__ = {
  resolveProtocol,
  buildModel,
  stripReasoningParts,
  toAiSdkUserContent,
  toolOutputHasImage,
  projectToolResultImages,
  sanitizeToolMessagePairs,
  chargeLegSteps,
  resolveStepChunk,
}
