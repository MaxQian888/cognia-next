/**
 * `ai.generate-text` — drain the plugin AI provider stream into one string.
 *
 * The WIT contract is one-shot (`generate-text: func(...) -> result<string,
 * string>`), but `createAIProviderAPI().chat` is an async generator. This
 * handler is the adapter: it consumes every chunk and concatenates, capturing
 * the trailing usage chunk into the response envelope.
 *
 * The PII redaction gate runs *inside* `chat()` before any dispatch, so a WASM
 * guest cannot reach a provider by coming through this bridge instead of the
 * TypeScript plugin API — that ordering is load-bearing and is covered by a test.
 */

import { createAIProviderAPI } from "@/lib/plugin/api/ai-provider-api"
import { hasApiOrGuardPermission } from "@/lib/plugin/api/api-permission-gate"
import type { AIChatMessage, AIChatOptions } from "@/types/plugin/plugin"

import { WasmBridgeError } from "../errors"
import { MAX_PAYLOAD_BYTES, serializedByteLength } from "../protocol"

export interface AiGenerateTextResult {
  text: string
  finishReason?: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
}

function parseMessages(payload: Record<string, unknown>): AIChatMessage[] {
  const raw = payload.messages
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new WasmBridgeError(
      "INVALID_REQUEST",
      "ai.generate-text: `messages` must be a non-empty array"
    )
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new WasmBridgeError(
        "INVALID_REQUEST",
        `ai.generate-text: messages[${index}] is not an object`
      )
    }
    const { role, content } = entry as Record<string, unknown>
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new WasmBridgeError(
        "INVALID_REQUEST",
        `ai.generate-text: messages[${index}].role must be user|assistant|system`
      )
    }
    if (typeof content !== "string") {
      throw new WasmBridgeError(
        "INVALID_REQUEST",
        `ai.generate-text: messages[${index}].content must be a string`
      )
    }
    return { role, content }
  })
}

function parseOptions(payload: Record<string, unknown>, signal: AbortSignal): AIChatOptions {
  const options: AIChatOptions = { signal }
  if (typeof payload.model === "string") options.model = payload.model
  if (typeof payload.temperature === "number") options.temperature = payload.temperature
  if (typeof payload.maxTokens === "number") options.maxTokens = payload.maxTokens
  if (typeof payload.topP === "number") options.topP = payload.topP
  if (Array.isArray(payload.stop) && payload.stop.every((s) => typeof s === "string")) {
    options.stop = payload.stop as string[]
  }
  return options
}

export async function aiGenerateText(
  pluginId: string,
  payload: Record<string, unknown>,
  signal: AbortSignal
): Promise<AiGenerateTextResult> {
  const messages = parseMessages(payload)

  const bytes = serializedByteLength(payload)
  if (bytes === null) {
    throw new WasmBridgeError("INVALID_REQUEST", "ai.generate-text: payload is not serializable")
  }
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new WasmBridgeError(
      "PAYLOAD_TOO_LARGE",
      `ai.generate-text: payload is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} byte limit`
    )
  }

  // Check explicitly rather than letting `createApiGuardedAPI`'s proxy throw:
  // that gives a typed CAPABILITY_DENIED instead of a PermissionError we would
  // have to re-classify, and it means we never construct the API (or touch the
  // provider registry) for a plugin that may not use it. The proxy still fires
  // underneath as defence in depth.
  if (!hasApiOrGuardPermission(pluginId, "ai:chat")) {
    throw new WasmBridgeError(
      "CAPABILITY_DENIED",
      `ai.generate-text: plugin \`${pluginId}\` was not granted \`ai:chat\``
    )
  }

  const api = createAIProviderAPI(pluginId)
  const options = parseOptions(payload, signal)

  let text = ""
  let finishReason: string | undefined
  let usage: AiGenerateTextResult["usage"]

  for await (const chunk of api.chat(messages, options)) {
    // Stop accumulating promptly even if a provider ignores the abort signal.
    if (signal.aborted) break
    if (chunk.content) text += chunk.content
    if (chunk.finishReason) finishReason = chunk.finishReason
    if (chunk.usage) usage = chunk.usage
  }

  return { text, finishReason, usage }
}
