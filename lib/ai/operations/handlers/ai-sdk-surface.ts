/**
 * The ONLY file under `lib/ai/operations/` allowed to import `ai` or
 * `@ai-sdk/*`. The PII-boundary gate is import-shaped: a dozen handlers each
 * importing `ai` would need a dozen allowlist entries and hollow the gate
 * out. One throat that also imports `@cognia/redact` needs none.
 *
 * Every wrapper runs the text PII gate on the outbound text fields before
 * the SDK call, in addition to the executor's own gate, so a handler that is
 * reached some other way is still gated.
 */

import {
  embed,
  embedMany,
  experimental_generateVideo,
  experimental_streamTranscribe,
  experimental_transcribe,
  generateImage,
  generateObject,
  generateSpeech,
  generateText,
  jsonSchema,
  rerank,
  streamText,
  tool,
} from "ai"
import { hasNoLeakingPii } from "@cognia/redact"

import { ProviderOperationPiiGateError } from "../failure"

function gateText(...values: Array<string | readonly string[] | undefined>): void {
  for (const value of values) {
    if (value === undefined) continue
    const texts = typeof value === "string" ? [value] : value
    for (const text of texts) {
      if (!hasNoLeakingPii(text)) throw new ProviderOperationPiiGateError()
    }
  }
}

export type GenerateTextArgs = Parameters<typeof generateText>[0]
export type StreamTextArgs = Parameters<typeof streamText>[0]
export type GenerateObjectArgs = Parameters<typeof generateObject>[0]
export type EmbedArgs = Parameters<typeof embed>[0]
export type EmbedManyArgs = Parameters<typeof embedMany>[0]
export type RerankArgs = Parameters<typeof rerank>[0]
export type GenerateImageArgs = Parameters<typeof generateImage>[0]
export type GenerateSpeechArgs = Parameters<typeof generateSpeech>[0]
export type TranscribeArgs = Parameters<typeof experimental_transcribe>[0]
export type StreamTranscribeArgs = Parameters<typeof experimental_streamTranscribe>[0]
export type GenerateVideoArgs = Parameters<typeof experimental_generateVideo>[0]
/** The messages form of a prompt, for handlers that must not import `ai`. */
export type PromptMessages = NonNullable<GenerateTextArgs["messages"]>

export function embedGated(args: EmbedArgs) {
  gateText(typeof args.value === "string" ? args.value : undefined)
  return embed(args)
}

export function embedManyGated(args: EmbedManyArgs) {
  gateText(args.values.filter((value): value is string => typeof value === "string"))
  return embedMany(args)
}

export function rerankGated(args: RerankArgs) {
  gateText(
    args.query,
    args.documents.filter((doc): doc is string => typeof doc === "string")
  )
  return rerank(args)
}

export function generateImageGated(args: GenerateImageArgs) {
  gateText(typeof args.prompt === "string" ? args.prompt : args.prompt.text)
  return generateImage(args)
}

export function generateSpeechGated(args: GenerateSpeechArgs) {
  gateText(args.text, args.instructions)
  return generateSpeech(args)
}

/** Audio in, text out: nothing textual leaves, so no gate applies. */
export function transcribeGated(args: TranscribeArgs) {
  return experimental_transcribe(args)
}

export function streamTranscribeGated(args: StreamTranscribeArgs) {
  return experimental_streamTranscribe(args)
}

export function generateVideoGated(args: GenerateVideoArgs) {
  gateText(typeof args.prompt === "string" ? args.prompt : undefined)
  return experimental_generateVideo(args)
}

/** Every string leaf in a prompt/messages/system tree, for the text gate. */
function promptTexts(args: { prompt?: unknown; system?: unknown; messages?: unknown }): string[] {
  const out: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (depth > 6 || value === null || value === undefined) return
    if (typeof value === "string") {
      out.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1)
      return
    }
    if (typeof value === "object") {
      for (const inner of Object.values(value as Record<string, unknown>)) walk(inner, depth + 1)
    }
  }
  walk(args.prompt, 0)
  walk(args.system, 0)
  walk(args.messages, 0)
  return out
}

export function generateTextGated(args: GenerateTextArgs) {
  gateText(promptTexts(args))
  return generateText(args)
}

export function streamTextGated(args: StreamTextArgs) {
  gateText(promptTexts(args))
  return streamText(args)
}

export function generateObjectGated(args: GenerateObjectArgs) {
  gateText(promptTexts(args as { prompt?: unknown; system?: unknown; messages?: unknown }))
  return generateObject(args)
}

/** A tool definition from a plain JSON schema, for callers that hold no zod. */
export function jsonSchemaTool(definition: {
  description?: string
  inputSchema: Record<string, unknown>
}) {
  return tool({
    ...(definition.description ? { description: definition.description } : {}),
    inputSchema: jsonSchema(definition.inputSchema),
  })
}

/** A structured-output schema from plain JSON schema. */
export function jsonSchemaOf<T = unknown>(schema: Record<string, unknown>) {
  return jsonSchema<T>(schema)
}
