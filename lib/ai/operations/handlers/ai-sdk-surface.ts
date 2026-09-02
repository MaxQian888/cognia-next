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
  generateSpeech,
  rerank,
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

export type EmbedArgs = Parameters<typeof embed>[0]
export type EmbedManyArgs = Parameters<typeof embedMany>[0]
export type RerankArgs = Parameters<typeof rerank>[0]
export type GenerateImageArgs = Parameters<typeof generateImage>[0]
export type GenerateSpeechArgs = Parameters<typeof generateSpeech>[0]
export type TranscribeArgs = Parameters<typeof experimental_transcribe>[0]
export type StreamTranscribeArgs = Parameters<typeof experimental_streamTranscribe>[0]
export type GenerateVideoArgs = Parameters<typeof experimental_generateVideo>[0]

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
  gateText(args.prompt)
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
