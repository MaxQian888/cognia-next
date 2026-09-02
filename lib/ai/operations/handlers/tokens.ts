/**
 * `tokens.count`. Native on the Anthropic protocol (`/v1/messages/
 * count_tokens`, the same endpoint the gateway forwards), and a labelled
 * local estimate everywhere else. The output says which it was.
 */

import { estimateFallbackTokens } from "@/lib/ai/tokens/fallback-estimator"

import type { ProviderOperationHandlerRegistration } from "../registry"
import { providerRequest } from "./http"

export interface TokensCountInput {
  model: string
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
  system?: string
  tools?: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }>
}

export interface TokensCountOutput {
  inputTokens: number
  method: "provider" | "estimate"
}

/** Every text leaf of the request, for the estimate. */
export function requestText(input: TokensCountInput): string {
  const parts: string[] = []
  if (input.system) parts.push(input.system)
  for (const message of input.messages) {
    if (typeof message.content === "string") parts.push(message.content)
    else for (const block of message.content) parts.push(JSON.stringify(block))
  }
  for (const tool of input.tools ?? []) {
    parts.push(tool.name, tool.description ?? "", JSON.stringify(tool.inputSchema))
  }
  return parts.join("\n")
}

export const tokensCountAnthropicHandler: ProviderOperationHandlerRegistration<
  TokensCountInput,
  TokensCountOutput
> = {
  operationId: "tokens.count",
  providerMatch: { kind: "protocol", protocol: "anthropic" },
  support: "native",
  async handler({ provider, request, signal }) {
    const { json } = await providerRequest<{ input_tokens: number }>(provider, {
      path: "messages/count_tokens",
      body: {
        model: request.input.model,
        messages: request.input.messages,
        ...(request.input.system ? { system: request.input.system } : {}),
        ...(request.input.tools
          ? {
              tools: request.input.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }
          : {}),
      },
      signal,
    })
    return { inputTokens: json.input_tokens, method: "provider" }
  },
}

export const tokensCountEstimateHandler: ProviderOperationHandlerRegistration<
  TokensCountInput,
  TokensCountOutput
> = {
  operationId: "tokens.count",
  providerMatch: { kind: "any" },
  support: "derived",
  async handler({ request }) {
    return { inputTokens: estimateFallbackTokens(requestText(request.input)), method: "estimate" }
  },
}

export const TOKENS_HANDLERS = [tokensCountAnthropicHandler, tokensCountEstimateHandler]
