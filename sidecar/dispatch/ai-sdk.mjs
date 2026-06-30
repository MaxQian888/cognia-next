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
import { createEventAdapter } from "./event-adapter.mjs"
import { makeInputStream } from "./input-stream.mjs"
import { extractHttpErrorMeta } from "./http-error-meta.mjs"
import { makeLazyLspResolver } from "./lsp-resolver-factory.mjs"
import { makeLazyCodeGraphResolver } from "./codegraph-resolver-factory.mjs"
import { createReadTracker } from "../builtin-tools/core/read-tracker.mjs"
import { createBgShellRegistry } from "../builtin-tools/core/bash-sessions.mjs"
import { resolveAdapter } from "./protocol-adapters/registry.mjs"
import { buildModel } from "./protocol-adapters/ai-sdk-adapter.mjs"
import {
  resolveProviderProtocol,
  normalizeProtocol,
} from "./protocol-adapters/provider-protocol.mjs"
import { shouldCompact, estimateTokens, makeSummaryMessage, summaryVersion } from "./compaction.mjs"
import { planStrategy } from "./compaction-strategies.mjs"
import { capToolResults } from "./tool-result-cap.mjs"
import { sanitizeToolMessagePairs } from "./tool-message-pairing.mjs"

// Recent user/assistant messages kept verbatim when compacting; everything
// older is summarized. Matches the Anthropic SDK's "keep the tail" behavior.
// Used only as the fallback when `sendOptions.compaction.keepRecent` is absent.
const COMPACT_KEEP_RECENT_MESSAGES = 6

// After this many accumulated frozen summaries, collapse them all into one
// (a bounded, one-time prefix-cache break) instead of appending another.
const MAX_FROZEN_SUMMARIES = 4

// Fallback summarization system prompt. The renderer normally supplies
// `sendOptions.compaction.summaryPrompt` (composed from the canonical prompt in
// `lib/ai/generation/summarizer.ts` + active strategy + user focus); this is
// used only when that is absent. Keep its intent in sync with that prompt.
const DEFAULT_SUMMARY_PROMPT =
  "You compact a long conversation. Produce a concise summary that preserves " +
  "decisions made, facts established, file paths, and any open threads. Use " +
  "terse bullet points. Do not add commentary."

// Fail-open deadline for a tool-result review round-trip. If the renderer
// doesn't answer (slow/crashed/no responder), the original output passes
// through so a tool result is never lost.
const TOOL_RESULT_REVIEW_TIMEOUT_MS = 30_000

// Map a provider id (or explicit `protocol` field) to the AI SDK family the
// renderer uses to construct a model instance. Custom provider ids must
// supply `providerCredentials.protocol` because the id alone tells us nothing.
// The id→protocol table is the single source of truth in `provider-protocol.mjs`;
// the renderer's resolver forwards `providerCredentials.protocol` for every turn,
// so this id-based path is the fallback for callers that don't (CLI, older code).
function resolveProtocol(provider, credentials) {
  if (credentials?.protocol) return normalizeProtocol(credentials.protocol)
  return resolveProviderProtocol(provider)
}

// `buildModel` moved to `protocol-adapters/ai-sdk-adapter.mjs` (the built-in
// adapter behind the ProtocolAdapter seam); re-imported above so the
// `__testing__` surface stays stable.

/**
 * Drop `reasoning` parts from assistant messages before they re-enter the
 * conversation history. Reasoning models (deepseek-reasoner et al.) reject
 * requests whose history contains reasoning content (HTTP 400), and even
 * where accepted, per-turn reasoning traces poison the provider's prompt-
 * cache prefix. Assistant messages whose content becomes empty after the
 * filter are dropped entirely; non-assistant messages pass through untouched.
 */
function stripReasoningParts(messages) {
  const out = []
  for (const msg of messages) {
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg)
      continue
    }
    const filtered = msg.content.filter((part) => part?.type !== "reasoning")
    if (filtered.length === 0) continue
    out.push(filtered.length === msg.content.length ? msg : { ...msg, content: filtered })
  }
  return out
}

/**
 * Convert an Anthropic agent-SDK content-block array (what the composer emits)
 * into AI SDK v6 user-message content parts.
 *
 * Anthropic shape → AI SDK v6 shape:
 *  - `{ type:'text', text }`                                  → unchanged
 *  - `{ type:'image', source:{ type:'base64', media_type, data } }`
 *        → `{ type:'image', image:'data:<media_type>;base64,<data>', mediaType }`
 *  - `{ type:'image', source:{ type:'url', url } }`           → `{ type:'image', image:url }`
 *  - `{ type:'document'|'file', source:{ type:'base64', media_type, data } }`
 *        → `{ type:'file', data:'data:<media_type>;base64,<data>', mediaType }`
 *  - blocks already in AI SDK shape (`{ type:'image', image }`,
 *    `{ type:'file', data }`) pass through untouched (idempotent)
 *  - strings and any unrecognised block pass through verbatim so content is
 *    never silently dropped.
 *
 * Exported via `__testing__` for unit coverage.
 *
 * @param {any[]} blocks
 * @returns {any[]}
 */
function toAiSdkUserContent(blocks) {
  if (!Array.isArray(blocks)) return blocks
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block
    const src = block.source
    const isBase64Source = src && typeof src === "object" && src.type === "base64"
    const isUrlSource = src && typeof src === "object" && src.type === "url"

    if (block.type === "image") {
      // Already AI SDK shape — leave as-is.
      if ("image" in block && !src) return block
      if (isBase64Source) {
        return {
          type: "image",
          image: `data:${src.media_type ?? ""};base64,${src.data ?? ""}`,
          ...(src.media_type ? { mediaType: src.media_type } : {}),
        }
      }
      if (isUrlSource && typeof src.url === "string") {
        return { type: "image", image: src.url }
      }
      return block
    }

    if (block.type === "document" || block.type === "file") {
      // Already AI SDK file shape — leave as-is.
      if ("data" in block && !src) return block
      if (isBase64Source) {
        return {
          type: "file",
          data: `data:${src.media_type ?? ""};base64,${src.data ?? ""}`,
          mediaType: src.media_type ?? "application/octet-stream",
        }
      }
      if (isUrlSource && typeof src.url === "string") {
        return {
          type: "file",
          data: src.url,
          mediaType: src.media_type ?? "application/octet-stream",
        }
      }
      return block
    }

    return block
  })
}

/**
 * Does a tool's execute output carry an image? Tolerant of both shapes a step's
 * `toolResults[i].output` can take: the raw MCP `CallToolResult`
 * (`{ content:[{ type:'image', data, mimeType }] }`, what our built-in `read`
 * returns) and the already-mapped `toModelOutput` content form
 * (`{ type:'content', value:[{ type:'image-data'|'file-data'|'media', mediaType }] }`).
 *
 * @param {unknown} output
 * @returns {boolean}
 */
function toolOutputHasImage(output) {
  if (!output || typeof output !== "object") return false
  const o = /** @type {Record<string, any>} */ (output)
  if (Array.isArray(o.content)) {
    if (o.content.some((b) => b && b.type === "image" && typeof b.data === "string")) return true
  }
  if (o.type === "content" && Array.isArray(o.value)) {
    return o.value.some(
      (v) =>
        v &&
        (v.type === "image-data" || v.type === "file-data" || v.type === "media") &&
        typeof v.mediaType === "string" &&
        v.mediaType.startsWith("image/")
    )
  }
  return false
}

/**
 * Most non-Anthropic provider APIs cannot carry an image INSIDE a tool-result
 * message (OpenAI Chat Completions, Mistral, Cohere, and older Gemini have no
 * slot for it; the AI SDK then serializes the image to a base64 JSON string the
 * model can't read). The portable fix: pull every image out of the model's
 * tool-result messages and re-project it as a normal USER-message image part —
 * which every vision model accepts — leaving a short text marker behind.
 *
 * Returns the AI SDK user-content image parts found, plus a sanitized copy of
 * `messages` with the image payloads replaced by text. Non-tool messages and
 * image-free tool results pass through untouched (object identity preserved when
 * nothing changed, so a no-image turn is a true no-op).
 *
 * @param {Array<any>} messages  AI SDK ModelMessages (from `result.response.messages`).
 * @returns {{ images: Array<{ type: "image", image: string, mediaType: string }>, sanitized: Array<any> }}
 */
function projectToolResultImages(messages) {
  if (!Array.isArray(messages)) return { images: [], sanitized: messages }
  const images = []
  const sanitized = messages.map((msg) => {
    if (!msg || msg.role !== "tool" || !Array.isArray(msg.content)) return msg
    let msgChanged = false
    const content = msg.content.map((part) => {
      if (!part || part.type !== "tool-result") return part
      const out = part.output
      if (!out || out.type !== "content" || !Array.isArray(out.value)) return part
      let partChanged = false
      const value = out.value.map((v) => {
        const isImage =
          v &&
          (v.type === "image-data" || v.type === "file-data" || v.type === "media") &&
          typeof v.data === "string" &&
          typeof v.mediaType === "string" &&
          v.mediaType.startsWith("image/")
        if (!isImage) return v
        partChanged = true
        images.push({
          type: "image",
          image: `data:${v.mediaType};base64,${v.data}`,
          mediaType: v.mediaType,
        })
        return {
          type: "text",
          text: `[image returned by ${part.toolName ?? "tool"} — shown in the next message]`,
        }
      })
      if (!partChanged) return part
      msgChanged = true
      // Collapse to a plain-text output when nothing but text remains, so a
      // chat-completions provider receives clean text rather than a JSON array.
      const allText = value.every((v) => v && v.type === "text")
      const nextOutput = allText
        ? { type: "text", value: value.map((v) => v.text).join("\n") }
        : { ...out, value }
      return { ...part, output: nextOutput }
    })
    return msgChanged ? { ...msg, content } : msg
  })
  return { images, sanitized }
}

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
function chargeLegSteps({ legStepsRead, legStepsRun, perLegCap }) {
  if (!legStepsRead) return 1
  return legStepsRun > 0 ? Math.min(legStepsRun, perLegCap) : perLegCap
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
  streamText: streamTextOverride,
  buildMcpTools: buildMcpToolsOverride,
}) {
  // Code-level protocol adapters round-trip through the renderer; the host
  // resolves `protocol_adapter_*` against this Map (per-session, like
  // pendingPluginToolCalls).
  const pendingProtocolExecs = new Map()
  const protocol = resolveProtocol(provider, sendOptions.providerCredentials)

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
  const protocolAdapter = resolveAdapter(protocol, sendOptions.protocolAdapterSpec, {
    emit,
    sessionId,
    pendingProtocolExecs,
  })
  if (!protocolAdapter) {
    emit({
      type: "session_ended",
      sessionId,
      error: `provider "${provider}" has no resolvable AI SDK protocol — set providerCredentials.protocol explicitly`,
    })
    return null
  }

  // Live-switchable. The renderer can change the model mid-session via the
  // `setModel` session control (see the `q.setModel` below, the ai-sdk parity
  // for the Anthropic SDK's `Query.setModel`). It's a `let` so every closure
  // that reads it — `maybeCompact`, the agent-loop `protocolAdapter.start`, and
  // the auto-compaction threshold — picks up the new model on the NEXT turn
  // without tearing down the multi-turn loop (which would drop the in-process
  // conversation). Validated once here with its initial value.
  let model = sendOptions.model
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

  const sdkSessionId = randomUUID()
  emit({
    type: "sdk_session_id",
    sessionId,
    sdkSessionId,
  })

  const adapter = createEventAdapter({
    sessionId,
    sdkSessionId,
    model,
    provider,
    startedAt: Date.now(),
  })

  // For multi-turn support we accumulate user messages in a queue. A new
  // `streamText` is started on every push so each turn is a fresh request.
  // The first turn fires immediately.
  const inputStream = makeInputStream()
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
  let activeAbortController = null
  // Creds/params from the most recent turn — let a manual compaction (between
  // turns) reuse them for its one-shot summary call. A deferred manual request
  // (turn in flight) is parked here and honoured at the next turn's head.
  let lastCreds = {}
  let lastModelParams = {}
  let manualCompactPending = null

  // Plugin tools round-trip through the renderer; claude-host resolves
  // `plugin_tool_response` against this Map (same contract as the Anthropic
  // path). Exposed on the returned session so the host can reach it.
  const pendingPluginToolCalls = new Map()
  // Tool-permission approvals round-trip the same way (`permission_request` →
  // `permission_response`), resolved by claude-host against this Map.
  const pendingApprovals = new Map()
  // Tool-result reviews (plugin SDK PostToolUse rewrite) round-trip via
  // `tool_result_review` → `tool_result_decision`, resolved by claude-host
  // against this Map. Engaged only when `sendOptions.toolResultReviewEnabled`.
  const pendingToolResultReviews = new Map()
  const toolResultReviewEnabled = sendOptions.toolResultReviewEnabled === true
  // Correlate tool-call ids → names so a tool-result review names its tool.
  const toolNamesById = new Map()
  // Tools are stable for the session — build once, reuse across turns.
  /** @type {Record<string, unknown> | undefined} */
  let toolsCache
  // Doom-loop guards owned by this session (the tool gate's + the MCP gate's).
  // The tools map is built once, so the guards live for the whole multi-turn
  // session; reset them per turn so a legitimate identical call repeated ACROSS
  // turns (e.g. reading the same config at the start of each turn) doesn't trip
  // the threshold — the Anthropic path resets implicitly via a fresh guard per
  // `query()`.
  /** @type {Array<{ reset: () => void }>} */
  const doomGuards = []
  // Teardown for external MCP-server connections, set when they're opened.
  /** @type {(() => Promise<void>) | null} */
  let mcpClose = null
  // Session-scoped read-before-write tracking for the core file tools, plus
  // the lazy LSP resolver (same proxy semantics as the Anthropic path — this
  // also fixes the previous omission where lsp_* tools never reached the
  // ai-sdk bridge).
  const readTracker = createReadTracker()
  // Per-session background-shell registry (bash run_in_background); killed at
  // teardown so no background process outlives the session.
  const bgShells = createBgShellRegistry()
  const lsp = makeLazyLspResolver({ sendOptions, log })
  // Per-session code-graph index (resolver-bound like LSP). Lazily built on
  // first tool call; disposed at session teardown.
  const codeGraph = makeLazyCodeGraphResolver({ sendOptions, log })
  // Agentic step budget for the WHOLE user turn. The turn runs a manual agent
  // loop (see `runTurn`) of `STEP_CHUNK`-step legs until the model naturally
  // stops or this budget is exhausted — a runaway backstop, NOT a task-length
  // limit. Precedence: an explicit `maxTurns` (subagents / `/goal` set a
  // deliberate small budget) wins; otherwise the configurable `aiSdkMaxSteps`;
  // otherwise 256. This replaces a hard 16-step single leg that silently stopped
  // any multi-tool task on every non-Anthropic provider — the Anthropic Agent
  // SDK loops unbounded, so the two channels were badly asymmetric.
  const STEP_CHUNK = 16
  const baseStepsBudget =
    typeof sendOptions.maxTurns === "number" && sendOptions.maxTurns > 0
      ? sendOptions.maxTurns
      : typeof sendOptions.aiSdkMaxSteps === "number" && sendOptions.aiSdkMaxSteps > 0
        ? sendOptions.aiSdkMaxSteps
        : 256
  // A routed `@agent` clamps the loop by its own `maxTurns` (parity with the
  // Anthropic Agent SDK). Clamp DOWN only — never widen the turn's budget.
  const maxStepsBudget = agentMaxTurns ? Math.min(baseStepsBudget, agentMaxTurns) : baseStepsBudget

  function flushAdapter(events) {
    for (const e of events) {
      emit({ type: "event", sessionId, event: e })
    }
  }

  // Pause before a tool result reaches the model: emit a `tool_result_review`
  // and await the renderer's `tool_result_decision`. A returned
  // `updatedToolOutput` rewrites the output; `undefined`/`null` (no responder,
  // no change, or timeout) passes the original through. Returns a possibly-new
  // stream event with the output replaced.
  async function reviewToolResult(evt) {
    const isError = evt?.type === "tool-error"
    const current = isError
      ? evt.error instanceof Error
        ? evt.error.message
        : typeof evt.error === "string"
          ? evt.error
          : JSON.stringify(evt.error)
      : (evt.output ?? evt.result)
    const reviewId = randomUUID()
    const updated = await new Promise((resolve) => {
      pendingToolResultReviews.set(reviewId, { resolve })
      emit({
        type: "tool_result_review",
        sessionId,
        reviewId,
        toolUseId: evt.toolCallId ?? "",
        toolName: toolNamesById.get(evt.toolCallId) ?? "",
        result: current,
        isError,
      })
      setTimeout(() => {
        if (pendingToolResultReviews.has(reviewId)) {
          pendingToolResultReviews.delete(reviewId)
          resolve(undefined)
        }
      }, TOOL_RESULT_REVIEW_TIMEOUT_MS)
    })
    if (updated === undefined || updated === null) return evt
    return isError ? { ...evt, error: updated } : { ...evt, output: updated, result: updated }
  }

  // Build a flat conversation from accumulated user/assistant turns.
  // `systemPrompt` and `appendSystemPrompt` CONCATENATE (matching the
  // Anthropic path, where append extends the system prompt) — previously
  // append was silently dropped whenever a base system prompt was set,
  // losing A2UI/goal/plan/brief instructions on the non-Anthropic path.
  /** @type {Array<{ role: "user"|"assistant"|"system", content: any }>} */
  const conversation = []
  const systemParts = [
    // `@agent` overlay (if any) leads so the subagent's identity frames the turn,
    // with the app's base + appended sections kept beneath it.
    agentSystemPrompt,
    sendOptions.systemPrompt,
    sendOptions.appendSystemPrompt,
  ].filter((s) => typeof s === "string" && s.trim().length > 0)
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

  function pushUserToConversation(content) {
    if (typeof content === "string") {
      conversation.push({ role: "user", content })
    } else if (Array.isArray(content)) {
      // Multimodal content blocks arrive in the Anthropic agent-SDK shape
      // (`{ type:'image', source:{ type:'base64', media_type, data } }`) because
      // the composer targets the native Anthropic path. AI SDK v6 expects
      // `{ type:'image', image }` / `{ type:'file', data, mediaType }`, so the
      // blocks MUST be converted here — otherwise streamText drops every image
      // and non-Anthropic providers (OpenAI/Gemini/Mistral/…) see text only.
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

  // Render the to-be-summarized slice as plain transcript for the summary call.
  function renderForSummary(messages) {
    return messages
      .map((m) => {
        const text =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("")
              : ""
        return `${m.role}: ${text}`
      })
      .join("\n\n")
  }

  // Before a turn, if the previous turn's prompt crossed the auto-compact
  // threshold, summarize the older messages and splice the summary in. The
  // summary is produced by the same model (no tools); on any failure we skip
  // compaction rather than break the turn. Emits a `compact_boundary` system
  // event so the renderer marks it exactly like the Anthropic path.
  async function maybeCompact(creds, modelParams, { force = false, focus } = {}) {
    const comp = sendOptions.compaction ?? {}
    // Auto path: honour the enable toggle + the configured trigger. Manual
    // (`force`) bypasses both — the user asked for it explicitly.
    if (!force) {
      if (comp.enabled === false) return
      const args =
        comp.trigger === "message-count"
          ? {
              trigger: "message-count",
              messageCount: conversation.length,
              messageCountThreshold: comp.messageCountThreshold,
            }
          : {
              lastInputTokens,
              modelId: model,
              // Authoritative window resolved by the renderer (catalog-backed);
              // falls back to the regex table inside `shouldCompact` when absent.
              ...(typeof comp.contextWindow === "number"
                ? { contextWindow: comp.contextWindow }
                : {}),
              ...(typeof comp.fraction === "number" ? { fraction: comp.fraction } : {}),
            }
      if (!shouldCompact(args)) return
    }

    const keepRecent =
      typeof comp.keepRecent === "number" ? comp.keepRecent : COMPACT_KEEP_RECENT_MESSAGES

    const plan = planStrategy({
      strategy: comp.strategy,
      conversation,
      keepRecent,
      preserveSystemMessages: comp.preserveSystemMessages,
      recursiveChunkSize: comp.recursiveChunkSize,
      importanceThreshold: comp.importanceThreshold,
      retainedFraction: comp.retainedFraction,
      modelId: model,
    })
    if (plan.kind === "none") return

    // The renderer-supplied prompt already folds in the app-level focus; a
    // manual `/compact <focus>` arg layers an extra instruction on top.
    const basePrompt = comp.summaryPrompt || DEFAULT_SUMMARY_PROMPT
    const manualFocus = typeof focus === "string" ? focus.trim() : ""
    const systemPrompt = manualFocus
      ? `${basePrompt}\n\nFocus especially on: ${manualFocus}`
      : basePrompt

    // Summary executor: alternate cheap model + credentials + adapter, with the
    // output token cap. Returns trimmed text, or null on failure/empty. When AI
    // summarization is disabled, falls back to a deterministic extractive cut.
    const useAI = comp.useAISummarization !== false
    const summaryCap =
      typeof comp.maxSummaryTokens === "number" && comp.maxSummaryTokens > 0
        ? comp.maxSummaryTokens
        : 500
    const summarize = async (messages) => {
      const transcript = renderForSummary(messages)
      if (!useAI) {
        const cap = summaryCap * 4
        return transcript.length > cap
          ? `${transcript.slice(0, cap)}\n... (extractive summary truncated)`
          : transcript
      }
      try {
        const sum = comp.summary ?? {}
        const summaryModel = sum.model || model
        const summaryCreds = sum.credentials || creds
        let summaryAdapter = protocolAdapter
        if (sum.protocol) {
          const alt = resolveAdapter(sum.protocol, sum.protocolAdapterSpec, {
            emit,
            sessionId,
            pendingProtocolExecs,
          })
          if (alt) summaryAdapter = alt
        }
        const summaryParams = { ...modelParams, maxOutputTokens: summaryCap }
        const run = await summaryAdapter.start({
          model: summaryModel,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: transcript },
          ],
          modelParams: summaryParams,
          tools: undefined,
          maxSteps: 1,
          credentials: summaryCreds,
          streamTextFn: streamTextOverride,
        })
        let out = ""
        for await (const evt of run.fullStream) {
          if (evt?.type === "text-delta") out += evt.text ?? evt.textDelta ?? evt.delta ?? ""
        }
        return out.trim() || null
      } catch (err) {
        log("warn", `compaction summary failed, skipping: ${err?.message ?? err}`)
        return null
      }
    }

    // Reuse prior frozen summaries verbatim (prefix-cache stable) until too many
    // accumulate, then collapse once.
    const frozen = plan.frozen ?? []
    const regenerate = frozen.length >= MAX_FROZEN_SUMMARIES
    const nextVersion =
      (frozen.length > 0
        ? Math.max(frozenSummaryVersion, ...frozen.map(summaryVersion))
        : frozenSummaryVersion) + 1

    let next
    let decision = "reused"
    let summaryProduced = false

    if (plan.kind === "rebuild") {
      // Sliding-window (or a no-op fallback) — no LLM call.
      next = plan.rebuilt
    } else {
      let summaryText
      if (plan.kind === "chunked") {
        const parts = []
        for (const chunk of plan.chunks) {
          const s = await summarize(chunk)
          if (s) parts.push(s)
        }
        if (regenerate && frozen.length) parts.unshift(renderForSummary(frozen))
        if (parts.length === 0) return
        summaryText =
          parts.length > 1 && useAI
            ? ((await summarize([{ role: "user", content: parts.join("\n\n") }])) ??
              parts.join("\n\n"))
            : parts.join("\n\n")
      } else {
        const material = plan.kind === "selective" ? plan.summarizeSet : plan.middle
        const full = regenerate && frozen.length ? [...frozen, ...material] : material
        summaryText = await summarize(full)
      }
      if (!summaryText) return
      summaryProduced = true
      decision = regenerate ? "regenerated" : "reused"
      const summaryMsg = makeSummaryMessage(summaryText, nextVersion)
      const keep = plan.keep ?? []
      next = regenerate
        ? [...plan.systemHead, ...keep, summaryMsg, ...plan.tail]
        : [...plan.systemHead, ...frozen, ...keep, summaryMsg, ...plan.tail]
    }

    if (summaryProduced) frozenSummaryVersion = nextVersion

    // Per-tool-result cap (independent of the summary strategy).
    next = capToolResults(next, {
      maxToolResultTokens: comp.maxToolResultTokens,
      preserveToolCallMetadata: comp.preserveToolCallMetadata,
    })

    // Undo snapshot — copied BEFORE the splice when enabled.
    const preMessages = comp.captureUndoSnapshot ? conversation.map((m) => ({ ...m })) : undefined

    const preTokens = lastInputTokens || estimateTokens(conversation)
    // Replace the conversation contents in place (it is a const binding).
    conversation.splice(0, conversation.length, ...next)
    // Reset the trigger so we don't compact again until the window refills.
    lastInputTokens = 0
    emit({
      type: "event",
      sessionId,
      event: {
        type: "system",
        subtype: "compact_boundary",
        uuid: randomUUID(),
        session_id: sdkSessionId,
        compact_metadata: {
          trigger: force ? "manual" : "auto",
          pre_tokens: preTokens,
          post_tokens: estimateTokens(next),
          strategy: comp.strategy ?? "summary",
          ...(summaryProduced ? { frozenSummaryDecision: decision } : {}),
          ...(preMessages ? { pre_messages: preMessages } : {}),
        },
      },
    })
  }

  async function runTurn() {
    if (active || closing) return
    // Clear any leftover interrupt from a previous turn so this turn streams.
    cancelled = false
    active = true
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
        const { buildAiSdkTools } = await import("./ai-sdk-tools.mjs")
        const { createDoomLoopGuard } = await import("./doom-loop.mjs")
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
          sessionId,
          pendingApprovals,
          pendingPluginToolCalls,
          lspResolver: lsp.lspResolver,
          codeGraphResolver: codeGraph.codeGraphResolver,
          readTracker,
          bgShells,
          doomGuard: toolDoomGuard,
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
              buildMcpToolsOverride ?? (await import("./ai-sdk-mcp.mjs")).buildAiSdkMcpTools
            const { createToolPermissionGate } = await import("./ai-sdk-tools.mjs")
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
              gate: mcpGate,
              // A routed `@agent` narrows the allowlist to its own tools and
              // unions its deny-list (parity with the built-in tool path above).
              allowedTools: agentScopedSendOptions.allowedTools,
              disallowedTools: agentScopedSendOptions.disallowedTools,
              log,
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
              )
            }
          } catch (err) {
            log("warn", `external MCP setup failed, continuing without it: ${err?.message ?? err}`)
          }
        }
      }

      const abortController = new AbortController()
      activeAbortController = abortController

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
      // Summed usage across legs, so the trailing `result` reports the whole turn.
      let accInputTokens = 0
      let accOutputTokens = 0
      let lastUsageForFinish = null

      // eslint-disable-next-line no-constant-condition
      while (true) {
        // Fresh content block per leg (new messageId) so the renderer keeps each
        // leg's text/tool calls distinct instead of merging them into one block.
        adapter.reset()

        // Compact the accumulated history first if the previous leg/turn
        // overflowed the window — keeps local / OpenAI / Gemini models from
        // silently exceeding their context the way the Anthropic SDK auto-compacts.
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
          const last = messagesForSend[lastIdx]
          messagesForSend = [
            ...messagesForSend.slice(0, lastIdx),
            {
              ...last,
              providerOptions: {
                ...(last.providerOptions ?? {}),
                anthropic: {
                  ...(last.providerOptions?.anthropic ?? {}),
                  cacheControl: { type: "ephemeral" },
                },
              },
            },
          ]
        }

        // Never exceed the remaining turn budget; always allow at least 1 step.
        const perLegCap = Math.max(1, Math.min(STEP_CHUNK, maxStepsBudget - stepsUsed))

        const result = await protocolAdapter.start({
          model,
          messages: messagesForSend,
          modelParams,
          tools: toolsCache,
          maxSteps: perLegCap,
          credentials: creds,
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
                    last.toolResults.some((tr) => toolOutputHasImage(tr?.output))
                  )
                },
              }
            : {}),
          abortSignal: abortController.signal,
          streamTextFn: streamTextOverride,
        })

        let legText = ""
        // Capture a streamed error part. AI SDK v6 surfaces provider/auth/network
        // failures as a `{ type:"error", error }` part in `fullStream` (and only
        // console.errors them via the default onError) rather than throwing.
        let streamError = null
        // The closing `finish` part carries the leg's finishReason — the signal
        // that decides whether to continue the agent loop.
        let finishReason = null
        for await (const evt of result.fullStream) {
          if (cancelled) break
          if (evt?.type === "error") streamError = evt.error
          if (evt?.type === "finish") finishReason = evt.finishReason ?? finishReason
          if (evt?.type === "tool-call" && evt.toolCallId) {
            toolNamesById.set(evt.toolCallId, evt.toolName ?? "")
          }
          // PostToolUse rewrite: let the renderer review/rewrite tool output
          // before the model sees it (opt-in; ai-sdk channel only).
          const handled =
            toolResultReviewEnabled && (evt?.type === "tool-result" || evt?.type === "tool-error")
              ? await reviewToolResult(evt)
              : evt
          const out = adapter.handle(handled)
          flushAdapter(out)
          if (evt?.type === "text-delta") {
            legText += evt.text ?? evt.textDelta ?? evt.delta ?? ""
          }
        }
        assistantText += legText

        // A streamed error before ANY text in the whole turn is a failed turn —
        // report the real provider message instead of a silent empty
        // `session_ended` (which the loop maps to "no assistant text"). Returning
        // here also skips the `result.response`/`result.usage` reads below, whose
        // getters reject on a hard error.
        if (streamError && !assistantText && !cancelled) {
          const msg =
            streamError instanceof Error
              ? streamError.message
              : typeof streamError === "string"
                ? streamError
                : (streamError?.message ?? JSON.stringify(streamError))
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
          const resp = await result.response
          if (resp && Array.isArray(resp.messages)) respMessages = resp.messages
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
        const usage = usageResult ? await usageResult.catch(() => null) : null
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
        // short to re-project a tool image (the model must see it next). Anything
        // else ends the turn here.
        if (finishReason === "tool-calls" || injectedToolImages) {
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
        assistantText += note
      }

      // Trailing `result` reports the whole turn's summed usage (all legs) — the
      // correct cumulative-billing figure. But `inputTokens` summed across legs
      // over-counts the CONTEXT WINDOW (each leg re-sends the whole growing
      // prompt), so we also surface the LAST leg's prompt size separately: that
      // is what actually occupies the window after the turn. The renderer's
      // window math reads `contextInputTokens`; cost/session totals keep using
      // the summed `inputTokens`.
      const finishUsage = lastUsageForFinish
        ? {
            ...lastUsageForFinish,
            ...(accInputTokens > 0 ? { inputTokens: accInputTokens } : {}),
            ...(accOutputTokens > 0 ? { outputTokens: accOutputTokens } : {}),
            ...(lastInputTokens > 0 ? { contextInputTokens: lastInputTokens } : {}),
          }
        : undefined
      const finishEvents = adapter.finish({ usage: finishUsage })
      flushAdapter(finishEvents)
      if (turnError && !cancelled) {
        // A provider error AFTER partial text already streamed (e.g. a 429 /
        // overloaded / connection-reset mid-reply). `finish` above closed the
        // content blocks so the partial is preserved, but we must still report
        // the error: a clean `session_ended` here would (a) skip the renderer's
        // routing fallback and breaker recording, and (b) present a truncated
        // reply as a successful turn. Symmetric with the pre-text error branch
        // above — forward the real HTTP status + Retry-After so the renderer
        // classifies off authoritative data.
        const msg =
          turnError instanceof Error
            ? turnError.message
            : typeof turnError === "string"
              ? turnError
              : (turnError?.message ?? JSON.stringify(turnError))
        emit({
          type: "session_ended",
          sessionId,
          error: msg,
          ...extractHttpErrorMeta(turnError),
        })
      } else {
        emit({ type: "session_ended", sessionId })
      }
    } catch (err) {
      // An aborted turn (user interrupt) is a clean stop, not a failure —
      // streamText rejects with an AbortError once the signal fires.
      if (cancelled || err?.name === "AbortError" || err?.name === "TimeoutError") {
        emit({ type: "session_ended", sessionId })
      } else {
        emit({
          type: "session_ended",
          sessionId,
          error: err?.message ?? String(err),
        })
      }
    } finally {
      active = false
      activeAbortController = null
    }
  }

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
      log("error", `ai-sdk dispatch loop failed: ${err?.message ?? err}`)
    })
    .finally(() => {
      // Session loop ended (input closed or fatal error) — kill any background
      // shells the agent left running so none outlive the session.
      bgShells.killAll()
      // Signal the host to retire this multi-turn session entry. Per-turn
      // `session_ended` events keep the session alive (so context accumulates);
      // this fires exactly once, when the loop genuinely ends.
      emit({ type: "session_closed", sessionId })
    })

  return {
    // Marks this dispatcher as a long-lived, multi-turn session: the host keeps
    // the session entry across per-turn `session_ended` events so the in-process
    // `conversation[]` (the only place context lives for non-Anthropic
    // providers) survives. Retired on `session_closed` / explicit close.
    multiTurn: true,
    q: {
      interrupt: async () => {
        cancelled = true
        // Abort the in-flight provider request so it stops immediately instead
        // of running to completion while we ignore the rest of the stream.
        activeAbortController?.abort()
        // Resolve every pending round-trip as denied/aborted so the tool gate
        // (or plugin-tool / tool-result-review / protocol-adapter exec) doesn't
        // hang forever waiting for a renderer that already timed out.
        // `handleInterrupt` (claude-host.mjs) calls this BEFORE timeout, and
        // the renderer-side timeout calls it too — so a stuck session cleans up
        // regardless of which side triggers the interrupt first.
        for (const [id, p] of pendingApprovals) {
          pendingApprovals.delete(id)
          p.resolve({ behavior: "deny", message: "interrupted" })
        }
        for (const [id, p] of pendingPluginToolCalls) {
          pendingPluginToolCalls.delete(id)
          p.resolve({ result: undefined, error: "interrupted" })
        }
        for (const [id, p] of pendingToolResultReviews) {
          pendingToolResultReviews.delete(id)
          p.resolve(undefined) // pass through unchanged
        }
        // Protocol-adapters have a `.fail` method on their pending channel, not
        // a bare resolve — mirror `handleProtocolAdapterError`'s teardown.
        if (pendingProtocolExecs) {
          for (const [id, ch] of pendingProtocolExecs) {
            pendingProtocolExecs.delete(id)
            try {
              ch.fail("interrupted")
            } catch {
              /* defensive — the channel shape is adapter-defined */
            }
          }
        }
      },
      /** True while a turn is in-flight (exposed for `handleSend` defense). */
      get active() {
        return active
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
      setModel: (nextModel) => {
        if (typeof nextModel !== "string" || !nextModel) return
        model = nextModel
        sendOptions.model = nextModel
        adapter.setModel(nextModel)
      },
    },
    pushUserMessage: (content) => inputStream.push(content),
    // Manual compaction (renderer `/compact` or "Compact now"). When idle, run
    // the summary now reusing the last turn's creds; when a turn is in flight,
    // defer to the next turn's head so two summary calls never overlap.
    requestCompact: async (focus) => {
      if (closing) return
      if (active) {
        manualCompactPending = { focus }
        return
      }
      await maybeCompact(lastCreds, lastModelParams, { force: true, focus }).catch((err) =>
        log("warn", `manual compaction failed: ${err?.message ?? err}`)
      )
    },
    // Undo a prior compaction by restoring the pre-compaction message snapshot.
    // Only valid while the session is live and idle (the renderer gates the UI
    // on "no intervening user turn"); a no-op while a turn is in flight.
    restoreConversation: (messages) => {
      if (closing || active) {
        log("warn", "restore ignored: session closing or turn in flight")
        return false
      }
      if (!Array.isArray(messages) || messages.length === 0) return false
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
      activeAbortController?.abort()
      inputStream.close()
      lsp.dispose()
      codeGraph.dispose()
      // Disconnect any external MCP servers opened for this session.
      if (mcpClose) {
        const done = mcpClose
        mcpClose = null
        void done().catch((err) => log("warn", `mcp teardown failed: ${err?.message ?? err}`))
      }
    },
    pendingApprovals,
    pendingPluginToolCalls,
    pendingProtocolExecs,
    pendingToolResultReviews,
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
}
