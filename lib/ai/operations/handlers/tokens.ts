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

/**
 * Move every `role: "system"` turn out of `messages` and into the top-level
 * `system` field.
 *
 * `chatMessageSchema` admits a system turn at any position, but Anthropic's
 * `/v1/messages` family rejects one inside `messages` outright — there is no
 * `allowSystemInMessages` escape hatch the way AI SDK 7 has one, so the
 * interleaved case `partitionPrompt` preserves has no representation on this
 * wire. Hoisting all of them is the only sendable reading, and it is a faithful
 * one here: where system content sits does not change what it costs, and a
 * count is the whole point of the operation.
 *
 * The shape widens only when it has to. With nothing to hoist the body still
 * carries `input.system` as the plain string it always did; a hoist switches
 * `system` to the text-block array that can hold several segments, which is the
 * other form the endpoint accepts.
 */
export function hoistSystemContent(input: TokensCountInput): {
  system?: string | Array<Record<string, unknown>>
  messages: TokensCountInput["messages"]
} {
  const messages = input.messages.filter((message) => message.role !== "system")
  if (messages.length === input.messages.length) {
    return { ...(input.system ? { system: input.system } : {}), messages }
  }
  const blocks: Array<Record<string, unknown>> = []
  // An empty text block is itself a 400, so a blank segment is dropped rather
  // than forwarded — the same rule `partitionPrompt` applies to its own input.
  if (input.system?.trim()) blocks.push({ type: "text", text: input.system })
  for (const message of input.messages) {
    if (message.role !== "system") continue
    if (typeof message.content !== "string") blocks.push(...message.content)
    else if (message.content.trim()) blocks.push({ type: "text", text: message.content })
  }
  return { ...(blocks.length > 0 ? { system: blocks } : {}), messages }
}

export const tokensCountAnthropicHandler: ProviderOperationHandlerRegistration<
  TokensCountInput,
  TokensCountOutput
> = {
  operationId: "tokens.count",
  providerMatch: { kind: "protocol", protocol: "anthropic" },
  support: "native",
  async handler({ provider, request, signal }) {
    const { system, messages } = hoistSystemContent(request.input)
    if (messages.length === 0) {
      // Nothing survived the hoist (or nothing was sent): there is no `messages`
      // array Anthropic would accept, so answer with the labelled local estimate
      // instead of sending a request that can only fail. The output says which
      // it was, which is what that field is for.
      return { inputTokens: estimateFallbackTokens(requestText(request.input)), method: "estimate" }
    }
    const { json } = await providerRequest<{ input_tokens: number }>(provider, {
      path: "messages/count_tokens",
      body: {
        model: request.input.model,
        messages,
        ...(system ? { system } : {}),
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
