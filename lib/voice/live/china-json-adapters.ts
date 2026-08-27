import type {
  Experimental_RealtimeModelV4 as RealtimeModel,
  Experimental_RealtimeModelV4ClientEvent as ClientEvent,
  Experimental_RealtimeModelV4ServerEvent as ServerEvent,
  Experimental_RealtimeModelV4SessionConfig as SessionConfig,
} from "@ai-sdk/provider"

type JsonRecord = Record<string, unknown>

function record(value: unknown, label = "event"): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`malformed realtime ${label}`)
  }
  return value as JsonRecord
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function ids(event: JsonRecord): { responseId: string; itemId: string } {
  const response = record(event.response ?? {}, "response")
  const item = record(event.item ?? {}, "item")
  return {
    responseId: stringField(event.response_id, stringField(response.id, "response")),
    itemId: stringField(event.item_id, stringField(item.id, "item")),
  }
}

function buildSessionConfig(provider: "qwen" | "baidu", config: SessionConfig): JsonRecord {
  const isQwen = provider === "qwen"
  const turnDetection =
    config.turnDetection === undefined
      ? undefined
      : config.turnDetection === null
        ? null
        : {
            type:
              config.turnDetection.type === "semantic-vad"
                ? "server_vad"
                : config.turnDetection.type.replaceAll("-", "_"),
            ...(isQwen ? {} : { create_response: true, interrupt_response: true }),
          }
  return {
    modalities: isQwen ? ["audio", "text"] : ["text", "audio"],
    input_audio_format: isQwen ? "pcm" : "pcm16",
    output_audio_format: isQwen ? "pcm" : "pcm16",
    ...(config.inputAudioTranscription
      ? { input_audio_transcription: { model: isQwen ? "fun-asr" : "default" } }
      : {}),
    ...(config.instructions ? { instructions: config.instructions } : {}),
    ...(config.voice ? { voice: config.voice } : {}),
    ...(turnDetection === undefined ? {} : { turn_detection: turnDetection }),
    ...(config.tools?.length
      ? {
          tool_choice: "auto",
          tools: config.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }
      : {}),
  }
}

function serializeConversationItem(
  item: Extract<ClientEvent, { type: "conversation-item-create" }>["item"]
): JsonRecord {
  if (item.type === "text-message") {
    return { type: "message", role: item.role, content: [{ type: "input_text", text: item.text }] }
  }
  if (item.type === "audio-message") {
    return {
      type: "message",
      role: item.role,
      content: [{ type: "input_audio", audio: item.audio }],
    }
  }
  return { type: "function_call_output", call_id: item.callId, output: item.output }
}

function serialize(event: ClientEvent, configBuilder: (config: SessionConfig) => unknown): unknown {
  switch (event.type) {
    case "session-update":
      return { type: "session.update", session: configBuilder(event.config) }
    case "input-audio-append":
      return { type: "input_audio_buffer.append", audio: event.audio }
    case "input-audio-commit":
      return { type: "input_audio_buffer.commit" }
    case "input-audio-clear":
      return { type: "input_audio_buffer.clear" }
    case "conversation-item-create":
      return { type: "conversation.item.create", item: serializeConversationItem(event.item) }
    case "conversation-item-truncate":
      return {
        type: "conversation.item.truncate",
        item_id: event.itemId,
        content_index: event.contentIndex,
        audio_end_ms: event.audioEndMs,
      }
    case "response-create":
      return { type: "response.create", ...(event.options ? { response: event.options } : {}) }
    case "response-cancel":
      return { type: "response.cancel" }
  }
}

function parse(raw: unknown): ServerEvent | ServerEvent[] {
  const event = record(raw)
  const type = stringField(event.type)
  if (!type) throw new Error("malformed realtime event: missing type")
  const { responseId, itemId } = ids(event)
  switch (type) {
    case "session.created":
      return {
        type: "session-created",
        sessionId: stringField(record(event.session ?? {}).id),
        raw,
      }
    case "session.updated":
      return { type: "session-updated", raw }
    case "input_audio_buffer.speech_started":
      return { type: "speech-started", itemId: stringField(event.item_id) || undefined, raw }
    case "input_audio_buffer.speech_stopped":
      return { type: "speech-stopped", itemId: stringField(event.item_id) || undefined, raw }
    case "input_audio_buffer.committed":
      return {
        type: "audio-committed",
        itemId: stringField(event.item_id) || undefined,
        previousItemId: stringField(event.previous_item_id) || undefined,
        raw,
      }
    case "conversation.item.input_audio_transcription.completed":
      return {
        type: "input-transcription-completed",
        itemId,
        transcript: stringField(event.transcript),
        raw,
      }
    case "response.created":
      return { type: "response-created", responseId, raw }
    case "response.done":
      return {
        type: "response-done",
        responseId,
        status: stringField(record(event.response ?? {}).status, "completed"),
        raw,
      }
    case "response.audio.delta":
      return { type: "audio-delta", responseId, itemId, delta: stringField(event.delta), raw }
    case "response.audio.done":
      return { type: "audio-done", responseId, itemId, raw }
    case "response.audio_transcript.delta":
      return {
        type: "audio-transcript-delta",
        responseId,
        itemId,
        delta: stringField(event.delta),
        raw,
      }
    case "response.audio_transcript.done":
      return {
        type: "audio-transcript-done",
        responseId,
        itemId,
        transcript: stringField(event.transcript) || undefined,
        raw,
      }
    case "response.text.delta":
      return { type: "text-delta", responseId, itemId, delta: stringField(event.delta), raw }
    case "response.text.done":
      return {
        type: "text-done",
        responseId,
        itemId,
        text: stringField(event.text) || undefined,
        raw,
      }
    case "response.function_call_arguments.delta":
      return {
        type: "function-call-arguments-delta",
        responseId,
        itemId,
        callId: stringField(event.call_id),
        delta: stringField(event.delta),
        raw,
      }
    case "response.function_call_arguments.done":
      return {
        type: "function-call-arguments-done",
        responseId,
        itemId,
        callId: stringField(event.call_id),
        name: stringField(event.name, stringField(record(event.item ?? {}).name)),
        arguments: stringField(
          event.arguments,
          stringField(record(event.item ?? {}).arguments, "{}")
        ),
        raw,
      }
    case "error": {
      const error = record(event.error ?? {})
      return {
        type: "error",
        message: stringField(error.message, "Realtime provider error"),
        code: stringField(error.code) || undefined,
        raw,
      }
    }
    default:
      return { type: "custom", rawType: type, raw }
  }
}

function createJsonAdapter(provider: "qwen" | "baidu", modelId: string): RealtimeModel {
  return {
    specificationVersion: "v4",
    provider,
    modelId,
    doCreateClientSecret: async () => {
      throw new Error(`${provider} live voice uses the host keyring connection`)
    },
    getWebSocketConfig: ({ url }) => ({ url }),
    parseServerEvent: parse,
    serializeClientEvent: (event) =>
      serialize(event, (config) => buildSessionConfig(provider, config)),
    buildSessionConfig: (config) => buildSessionConfig(provider, config),
  }
}

export function createQwenLiveAdapter(modelId: string): RealtimeModel {
  return createJsonAdapter("qwen", modelId)
}

export function createBaiduLiveAdapter(modelId: string): RealtimeModel {
  return createJsonAdapter("baidu", modelId)
}
