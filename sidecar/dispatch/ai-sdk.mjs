// AI SDK dispatcher: runs a turn against `streamText()` from the `ai` package
// using `@ai-sdk/<provider>`'s client builder.
//
// Lazy-imports the per-provider SDKs so the sidecar's cold start doesn't pay
// for OpenAI when the user is on Anthropic, etc.
//
// Tools / MCP / A2UI are NOT wired here in P2 — that's a documented gap.
// Any chat that has `allowedTools` set but picks a non-Anthropic provider
// will be disabled in the composer (P3).

import { randomUUID } from "node:crypto"
import { createEventAdapter } from "./event-adapter.mjs"
import { makeInputStream } from "./input-stream.mjs"

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

  function flushAdapter(events) {
    for (const e of events) {
      emit({ type: "event", sessionId, event: e })
    }
  }

  // Build a flat conversation from accumulated user/assistant turns.
  /** @type {Array<{ role: "user"|"assistant"|"system", content: any }>} */
  const conversation = []
  if (sendOptions.systemPrompt) {
    conversation.push({ role: "system", content: sendOptions.systemPrompt })
  } else if (sendOptions.appendSystemPrompt) {
    conversation.push({ role: "system", content: sendOptions.appendSystemPrompt })
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
      const result = streamTextFn({
        model: modelInstance,
        messages: conversation,
        maxTokens: undefined,
        temperature: undefined,
      })

      let assistantText = ""
      for await (const evt of result.fullStream) {
        if (cancelled) break
        const out = adapter.handle(evt)
        flushAdapter(out)
        if (evt?.type === "text-delta") {
          assistantText += evt.textDelta ?? evt.delta ?? ""
        }
      }
      if (assistantText) {
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
    },
    pendingApprovals: new Map(),
    sendOptions,
  }
}

// Exported for tests.
export const __testing__ = { resolveProtocol, buildModel }
