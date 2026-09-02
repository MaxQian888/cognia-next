/**
 * `translation.create` (ADR-0163, Batch 16): speech in any language to
 * English text, in the contract shape shared with transcription. The AI SDK
 * exposes no audio translation call (its streamTranslate is a text stream
 * translator), so this is the OpenAI `audio/translations` multipart wire,
 * bound to the openai and azure protocols and mirrored by the compatible
 * vendors that declare the surface.
 */

import type { z } from "zod"
import type { translationCreateInput, translationCreateOutput } from "@cognia/provider-types"

import type { ProviderOperationHandlerRegistration } from "../registry"
import { blobOf, mimeTypeOf } from "./bytes"
import { providerUpload } from "./http"
import { requireModelId } from "./sdk-client"

export type TranslationCreateInput = z.infer<typeof translationCreateInput>
export type TranslationCreateOutput = z.infer<typeof translationCreateOutput>

interface OpenAiTranslation {
  text?: string
  language?: string
  segments?: Array<{ start?: number; end?: number; text?: string }>
}

/** A filename whose extension matches the audio type, which the wire needs. */
export function audioFilenameOf(mimeType: string): string {
  const extension = mimeType.split("/")[1]?.split(";")[0]?.replace(/^x-/, "") || "bin"
  return `audio.${extension === "mpeg" ? "mp3" : extension}`
}

function translationHandler(
  protocol: "openai" | "azure"
): ProviderOperationHandlerRegistration<TranslationCreateInput, TranslationCreateOutput> {
  return {
    operationId: "translation.create",
    providerMatch: { kind: "protocol", protocol },
    support: "native",
    async handler({ provider, request, signal }) {
      const input = request.input
      const form = new FormData()
      form.append("model", requireModelId(provider, input.model))
      form.append(
        "file",
        blobOf(input.audio),
        audioFilenameOf(mimeTypeOf(input.audio, "audio/wav"))
      )
      form.append("response_format", "verbose_json")
      const prompt = typeof input.extra?.prompt === "string" ? input.extra.prompt : undefined
      if (prompt) form.append("prompt", prompt)
      const { json } = await providerUpload<OpenAiTranslation>(provider, {
        path: "audio/translations",
        form,
        signal,
      })
      return {
        text: json.text ?? "",
        ...(json.language ? { language: json.language } : {}),
        ...(json.segments
          ? {
              segments: json.segments.map((segment) => ({
                start: segment.start ?? 0,
                end: segment.end ?? 0,
                text: segment.text ?? "",
              })),
            }
          : {}),
      }
    },
  }
}

export const TRANSLATION_HANDLERS: ProviderOperationHandlerRegistration[] = [
  translationHandler("openai"),
  translationHandler("azure"),
] as ProviderOperationHandlerRegistration[]
