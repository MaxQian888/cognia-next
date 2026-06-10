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
import { makeLazyLspResolver } from "./lsp-resolver-factory.mjs"
import { createReadTracker } from "../builtin-tools/core/read-tracker.mjs"
import { resolveAdapter } from "./protocol-adapters/registry.mjs"
import { buildModel } from "./protocol-adapters/ai-sdk-adapter.mjs"
import { shouldCompact, planCompaction, applyCompaction, estimateTokens } from "./compaction.mjs"

// Recent user/assistant messages kept verbatim when compacting; everything
// older is summarized. Matches the Anthropic SDK's "keep the tail" behavior.
const COMPACT_KEEP_RECENT_MESSAGES = 6

// Fail-open deadline for a tool-result review round-trip. If the renderer
// doesn't answer (slow/crashed/no responder), the original output passes
// through so a tool result is never lost.
const TOOL_RESULT_REVIEW_TIMEOUT_MS = 30_000

// Map a provider id (or explicit `protocol` field) to the AI SDK family the
// renderer uses to construct a model instance. Custom provider ids must
// supply `providerCredentials.protocol` because the id alone tells us nothing.
function resolveProtocol(provider, credentials) {
  if (credentials?.protocol) return credentials.protocol
  switch (provider) {
    case "openai":
    case "openrouter": // openrouter speaks the openai protocol with a custom baseURL
    case "opencode": // OpenCode Zen — OpenAI-compatible gateway (verified live)
    case "opencode-go": // OpenCode Go — same gateway, /go segment
    case "deepseek":
    case "groq":
    case "mistral-openai-compat":
    // Local inference engines all expose an OpenAI-compatible /v1 surface, so
    // they dispatch through the openai client with a custom baseURL. Built-in
    // ids must be recognised here because they reach the sidecar without an
    // explicit `providerCredentials.protocol` (only custom ids carry one).
    case "ollama":
    case "lmstudio":
    case "llamacpp":
    case "llamafile":
    case "vllm":
    case "localai":
    case "jan":
    case "textgenwebui":
    case "koboldcpp":
    case "tabbyapi":
      return "openai"
    case "google":
    case "gemini":
      return "google"
    case "mistral":
      return "mistral"
    case "cohere":
      return "cohere"
    case "anthropic":
      return "anthropic"
    default:
      return null
  }
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
 * @param {{
 *   provider: string,
 *   sessionId: string,
 *   firstPrompt: any,
 *   sendOptions: Record<string, any>,
 *   emit: (msg: any) => void,
 *   log: (level: "info"|"warn"|"error", message: string) => void,
 *   streamText?: any,  // injected for tests
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
}) {
  // Code-level protocol adapters round-trip through the renderer; the host
  // resolves `protocol_adapter_*` against this Map (per-session, like
  // pendingPluginToolCalls).
  const pendingProtocolExecs = new Map()
  const protocol = resolveProtocol(provider, sendOptions.providerCredentials)
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

  const model = sendOptions.model
  if (!model) {
    emit({
      type: "session_ended",
      sessionId,
      error: `model is required when provider is "${provider}"`,
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
  let cancelled = false

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
  // Session-scoped read-before-write tracking for the core file tools, plus
  // the lazy LSP resolver (same proxy semantics as the Anthropic path — this
  // also fixes the previous omission where lsp_* tools never reached the
  // ai-sdk bridge).
  const readTracker = createReadTracker()
  const lsp = makeLazyLspResolver({ sendOptions, log })
  // Cap agentic steps within a single turn so a tool loop can't run away.
  const maxSteps =
    typeof sendOptions.maxTurns === "number" && sendOptions.maxTurns > 0 ? sendOptions.maxTurns : 16

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
  const systemParts = [sendOptions.systemPrompt, sendOptions.appendSystemPrompt].filter(
    (s) => typeof s === "string" && s.trim().length > 0
  )
  if (
    systemParts.length > 0 &&
    protocol === "anthropic" &&
    sendOptions.cacheOptimizationEnabled === true
  ) {
    // Cache optimization + anthropic protocol: split the system prompt at
    // the stable/dynamic boundary and put an explicit cacheControl
    // breakpoint on the stable segment, leaving the per-turn tail
    // (appendSystemPrompt carries the dynamic sections) uncached so it
    // never churns the cache write.
    conversation.push({
      role: "system",
      content: systemParts[0],
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    })
    for (const part of systemParts.slice(1)) {
      conversation.push({ role: "system", content: part })
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
  async function maybeCompact(creds, modelParams) {
    if (!shouldCompact({ lastInputTokens, modelId: model })) return
    const plan = planCompaction({
      conversation,
      keepRecentMessages: COMPACT_KEEP_RECENT_MESSAGES,
    })
    if (!plan) return
    let summary
    try {
      const summaryRun = await protocolAdapter.start({
        model,
        messages: [
          {
            role: "system",
            content:
              "You compact a long conversation. Produce a concise summary that preserves decisions made, facts established, file paths, and any open threads. Use terse bullet points. Do not add commentary.",
          },
          { role: "user", content: renderForSummary(plan.middle) },
        ],
        modelParams,
        tools: undefined,
        maxSteps: 1,
        credentials: creds,
        streamTextFn: streamTextOverride,
      })
      let text = ""
      for await (const evt of summaryRun.fullStream) {
        if (evt?.type === "text-delta") text += evt.text ?? evt.textDelta ?? evt.delta ?? ""
      }
      summary = text.trim()
    } catch (err) {
      log("warn", `compaction summary failed, skipping: ${err?.message ?? err}`)
      return
    }
    if (!summary) return
    const preTokens = lastInputTokens
    const next = applyCompaction({
      conversation,
      keepRecentMessages: COMPACT_KEEP_RECENT_MESSAGES,
      summary,
    })
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
          trigger: "auto",
          pre_tokens: preTokens,
          post_tokens: estimateTokens(next),
        },
      },
    })
  }

  async function runTurn() {
    if (active || cancelled) return
    active = true
    try {
      const creds = sendOptions.providerCredentials ?? {}
      // `modelParams` carries the provider's configured sampling settings
      // (temperature, maxOutputTokens, topP, topK, penalties, stopSequences,
      // seed, maxRetries) in AI SDK v6 call-option naming. Spread them so the
      // turn honours the user's provider config instead of silently dropping
      // every knob. Undefined keys are omitted by the builder upstream.
      const modelParams = sendOptions.modelParams ?? {}

      // Build native AI SDK tools (built-in + plugin) once. Lazy-imported so
      // the bridge (and its `ai` dependency) doesn't load for tool-less turns.
      if (toolsCache === undefined) {
        const { buildAiSdkTools } = await import("./ai-sdk-tools.mjs")
        toolsCache = buildAiSdkTools({
          sendOptions,
          emit,
          sessionId,
          pendingApprovals,
          pendingPluginToolCalls,
          lspResolver: lsp.lspResolver,
          readTracker,
        })
      }

      // Compact the accumulated history first if the last turn overflowed the
      // window — keeps local / OpenAI / Gemini models from silently exceeding
      // their context the way the Anthropic SDK auto-compacts.
      await maybeCompact(creds, modelParams)

      const result = await protocolAdapter.start({
        model,
        messages: conversation,
        modelParams,
        tools: toolsCache,
        maxSteps,
        credentials: creds,
        streamTextFn: streamTextOverride,
      })

      let assistantText = ""
      for await (const evt of result.fullStream) {
        if (cancelled) break
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
          assistantText += evt.text ?? evt.textDelta ?? evt.delta ?? ""
        }
      }
      // Persist the turn into conversation history. When the SDK exposes the
      // full model message list (assistant text + tool calls + tool results),
      // prefer it so multi-turn context keeps tool history; otherwise fall back
      // to the accumulated assistant text.
      let respMessages = null
      try {
        const resp = result.response ? await result.response : null
        if (resp && Array.isArray(resp.messages)) respMessages = resp.messages
      } catch {
        respMessages = null
      }
      if (respMessages && respMessages.length > 0) {
        conversation.push(...stripReasoningParts(respMessages))
      } else if (assistantText) {
        conversation.push({ role: "assistant", content: assistantText })
      }
      const usage = result.usage ? await result.usage.catch(() => null) : null
      // Record the real prompt size so the next turn can decide whether to
      // compact. AI SDK v6 reports `inputTokens`; older shapes use `promptTokens`.
      if (usage) {
        const inTok = usage.inputTokens ?? usage.promptTokens
        if (typeof inTok === "number" && inTok > 0) lastInputTokens = inTok
      }
      const finishEvents = adapter.finish({ usage })
      flushAdapter(finishEvents)
      emit({ type: "session_ended", sessionId })
    } catch (err) {
      emit({
        type: "session_ended",
        sessionId,
        error: err?.message ?? String(err),
      })
    } finally {
      active = false
    }
  }

  // Wire the input-stream consumer: each pushed user message kicks off a turn.
  ;(async () => {
    pushUserToConversation(firstPrompt)
    await runTurn()
    for await (const next of inputStream.iterable) {
      if (cancelled) break
      pushUserToConversation(next)
      await runTurn()
    }
  })().catch((err) => {
    log("error", `ai-sdk dispatch loop failed: ${err?.message ?? err}`)
  })

  return {
    q: {
      interrupt: async () => {
        cancelled = true
      },
    },
    pushUserMessage: (content) => inputStream.push(content),
    closeInput: () => {
      cancelled = true
      inputStream.close()
      lsp.dispose()
    },
    pendingApprovals,
    pendingPluginToolCalls,
    pendingProtocolExecs,
    pendingToolResultReviews,
    sendOptions,
  }
}

// Exported for tests.
export const __testing__ = { resolveProtocol, buildModel, stripReasoningParts, toAiSdkUserContent }
