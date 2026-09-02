/**
 * `moderation.create`. The AI SDK has no moderation surface (checked against
 * ai@7), so this is a direct call to the vendors that expose one. Bound per
 * provider id, not by a vendor switch: adding a vendor is adding a
 * registration with its endpoint path.
 */

import type { ProviderOperationHandlerRegistration } from "../registry"
import { providerRequest } from "./http"

export interface ModerationCreateInput {
  input: string | string[]
  model?: string
}

export interface ModerationCreateOutput {
  results: Array<{
    flagged: boolean
    categories: Record<string, boolean>
    scores?: Record<string, number>
  }>
}

interface OpenAiStyleModeration {
  results?: Array<{
    flagged: boolean
    categories: Record<string, boolean>
    category_scores?: Record<string, number>
  }>
}

function openAiStyleHandler(
  providerId: string,
  defaultModel?: string
): ProviderOperationHandlerRegistration<ModerationCreateInput, ModerationCreateOutput> {
  return {
    operationId: "moderation.create",
    providerMatch: { kind: "provider", providerId },
    support: "native",
    async handler({ provider, request, signal }) {
      const { json } = await providerRequest<OpenAiStyleModeration>(provider, {
        path: "moderations",
        body: {
          input: request.input.input,
          ...((request.input.model ?? defaultModel)
            ? { model: request.input.model ?? defaultModel }
            : {}),
        },
        signal,
      })
      return {
        results: (json.results ?? []).map((row) => ({
          flagged: row.flagged,
          categories: row.categories ?? {},
          ...(row.category_scores ? { scores: row.category_scores } : {}),
        })),
      }
    },
  }
}

export const MODERATION_HANDLERS = [
  openAiStyleHandler("openai", "omni-moderation-latest"),
  openAiStyleHandler("mistral", "mistral-moderation-latest"),
]
