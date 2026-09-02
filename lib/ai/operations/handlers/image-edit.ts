/**
 * `images.edit` (ADR-0163, Batch 16), in the contract shape: the source
 * image, an optional mask and a prompt go through the AI SDK image model's
 * edit form (`prompt: { images, text, mask }`). Bound to the openai and
 * azure protocols, the vendors whose image models accept edits.
 */

import type { z } from "zod"
import type { imagesEditInput, imagesEditOutput } from "@cognia/provider-types"

import { ProviderOperationFailureError } from "../failure"
import type { ProviderOperationHandlerRegistration } from "../registry"
import { generateImageGated, type GenerateImageArgs } from "./ai-sdk-surface"
import { bytesRefOfGenerated, dataContentOf } from "./bytes"
import { providerSdkClient, requireModelFactory, requireModelId } from "./sdk-client"

export type ImagesEditInput = z.infer<typeof imagesEditInput>
export type ImagesEditOutput = z.infer<typeof imagesEditOutput>

type Size = `${number}x${number}`

function editHandler(
  protocol: "openai" | "azure"
): ProviderOperationHandlerRegistration<ImagesEditInput, ImagesEditOutput> {
  return {
    operationId: "images.edit",
    providerMatch: { kind: "protocol", protocol },
    support: "native",
    async handler({ provider, request, signal }) {
      const input = request.input
      if (input.size !== undefined && !/^\d+x\d+$/.test(input.size)) {
        throw new ProviderOperationFailureError({
          code: "schema",
          retryable: false,
          message: `size must look like 1024x1024, got "${input.size}"`,
        })
      }
      const client = providerSdkClient(provider)
      const make = requireModelFactory<GenerateImageArgs["model"]>(
        client,
        provider,
        ["imageModel"],
        "image"
      )
      const result = await generateImageGated({
        model: make(requireModelId(provider, input.model)),
        prompt: {
          images: [dataContentOf(input.image)],
          text: input.prompt,
          ...(input.mask ? { mask: dataContentOf(input.mask) } : {}),
        },
        ...(input.n !== undefined ? { n: input.n } : {}),
        ...(input.size !== undefined ? { size: input.size as Size } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      })
      return { images: result.images.map(bytesRefOfGenerated) }
    },
  }
}

export const IMAGE_EDIT_HANDLERS: ProviderOperationHandlerRegistration[] = [
  editHandler("openai"),
  editHandler("azure"),
] as ProviderOperationHandlerRegistration[]
