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

// Map a provider id (or explicit `protocol` field) to the AI SDK family the
// renderer uses to construct a model instance. Custom provider ids must
// supply `providerCredentials.protocol` because the id alone tells us nothing.
function resolveProtocol(provider, credentials) {
  if (credentials?.protocol) return credentials.protocol
  switch (provider) {
    case "openai":
    case "openrouter": // openrouter speaks the openai protocol with a custom baseURL
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

async function buildModel({ protocol, model, apiKey, baseURL }) {
  switch (protocol) {
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai")
      const client = createOpenAI({ apiKey, baseURL })
      return client(model)
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic")
      const client = createAnthropic({ apiKey, baseURL })
      return client(model)
    }
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google")
      const client = createGoogleGenerativeAI({ apiKey, baseURL })
      return client(model)
    }
    case "mistral": {
      const { createMistral } = await import("@ai-sdk/mistral")
      const client = createMistral({ apiKey, baseURL })
      return client(model)
    }
    case "cohere": {
      const { createCohere } = await import("@ai-sdk/cohere")
      const client = createCohere({ apiKey, baseURL })
      return client(model)
    }
    default:
      throw new Error(`unsupported AI SDK protocol: ${protocol}`)
  }
}

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
  const protocol = resolveProtocol(provider, sendOptions.providerCredentials)
  if (!protocol) {
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
      // Multimodal content blocks — pass through; AI SDK accepts text/image
      // arrays via the `content` field.
      conversation.push({ role: "user", content })
    }
  }

  async function runTurn() {
    if (active || cancelled) return
    active = true
    try {
      const creds = sendOptions.providerCredentials ?? {}
      const modelInstance = await buildModel({
        protocol,
        model,
        apiKey: creds.apiKey,
        baseURL: creds.baseURL,
      })
      const streamTextFn = streamTextOverride ?? (await import("ai")).streamText
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
      const hasTools = Object.keys(toolsCache).length > 0

      const streamArgs = {
        model: modelInstance,
        messages: conversation,
        ...modelParams,
      }
      if (hasTools) {
        streamArgs.tools = toolsCache
        // Multi-step agentic loop: AI SDK runs each tool's `execute` and feeds
        // the result back to the model until it stops or we hit the step cap.
        streamArgs.stopWhen = ({ steps }) => (steps?.length ?? 0) >= maxSteps
      }
      const result = streamTextFn(streamArgs)

      let assistantText = ""
      for await (const evt of result.fullStream) {
        if (cancelled) break
        const out = adapter.handle(evt)
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
      const usage = await result.usage.catch(() => null)
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
    sendOptions,
  }
}

// Exported for tests.
export const __testing__ = { resolveProtocol, buildModel, stripReasoningParts }
