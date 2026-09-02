/**
 * `language.generate`, `language.stream`, `language.tools` and
 * `language.structured-output`, all through the gated AI SDK surface over
 * the same model handle the chat path builds (`createFeatureProviderModel`).
 * Inputs and outputs are the named contract schemas (`languageGenerateInput`
 * and friends in `@cognia/provider-types`). Structured output is registered
 * as `translated` on the Anthropic and Bedrock protocols, where the SDK
 * emulates a schema through a tool call, and `native` elsewhere.
 */

import type { z } from "zod"
import type {
  chatMessageSchema,
  languageGenerateInput,
  languageGenerateOutput,
  languageStreamInput,
  languageStreamOutput,
  languageStructuredOutputInput,
  languageStructuredOutputOutput,
  languageToolsInput,
  languageToolsOutput,
} from "@cognia/provider-types"
import { createFeatureProviderModel, type ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"
import type { ProviderOperationHandlerRegistration } from "../registry"
import {
  generateObjectGated,
  generateTextGated,
  jsonSchemaOf,
  jsonSchemaTool,
  streamTextGated,
  type GenerateObjectArgs,
  type GenerateTextArgs,
  type PromptMessages,
} from "./ai-sdk-surface"
import { requireModelId } from "./sdk-client"

export type LanguageGenerateInput = z.infer<typeof languageGenerateInput>
export type LanguageGenerateOutput = z.infer<typeof languageGenerateOutput>
export type LanguageStreamInput = z.infer<typeof languageStreamInput>
export type LanguageToolsInput = z.infer<typeof languageToolsInput>
export type LanguageToolsOutput = z.infer<typeof languageToolsOutput>
export type LanguageStructuredOutputInput = z.infer<typeof languageStructuredOutputInput>
export type LanguageStructuredOutputOutput = z.infer<typeof languageStructuredOutputOutput>
export type ChatMessage = z.infer<typeof chatMessageSchema>

/** The contract's stream output plus the in-process stream itself. */
export interface LanguageStreamOutput extends z.infer<typeof languageStreamOutput> {
  /** Text deltas. Only reachable in-process, never over RPC. */
  textStream: AsyncIterable<string>
  /** Resolves with the terminal aggregate, which is also written to `final`. */
  completed: Promise<NonNullable<z.infer<typeof languageStreamOutput>["final"]>>
}

type FinishReason = NonNullable<LanguageGenerateOutput["finishReason"]>
const FINISH_REASONS: ReadonlySet<string> = new Set([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "other",
])

export function finishReasonOf(value: string | undefined): FinishReason {
  return value && FINISH_REASONS.has(value) ? (value as FinishReason) : "other"
}

function textOf(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content
  return content
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
}

/** Contract messages to AI SDK model messages. Content blocks pass through as parts. */
export function toModelMessages(messages: readonly ChatMessage[]): PromptMessages {
  return messages.map((message) => {
    switch (message.role) {
      case "system":
        return { role: "system", content: textOf(message.content) }
      case "tool":
        return {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId ?? "",
              toolName: message.name ?? "",
              output:
                typeof message.content === "string"
                  ? { type: "text", value: message.content }
                  : { type: "json", value: message.content },
            },
          ],
        }
      case "user":
      case "assistant":
        return { role: message.role, content: message.content } as PromptMessages[number]
    }
  }) as PromptMessages
}

type CallArgs = Pick<
  GenerateTextArgs,
  "system" | "maxOutputTokens" | "temperature" | "topP" | "stopSequences"
> & { messages: PromptMessages }

function callArgsOf(input: LanguageGenerateInput): CallArgs {
  if (input.messages.length === 0) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "a language request needs at least one message",
    })
  }
  return {
    messages: toModelMessages(input.messages),
    ...(input.system ? { system: input.system } : {}),
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.topP !== undefined ? { topP: input.topP } : {}),
    ...(input.stopSequences ? { stopSequences: input.stopSequences } : {}),
  }
}

function usageOf(
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined
) {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
  }
}

function modelFor(provider: ResolvedProvider, input: { model: string }) {
  const model = requireModelId(provider, input.model)
  return { model, handle: createFeatureProviderModel({ ...provider, model }) }
}

function toolsOf(input: LanguageToolsInput): NonNullable<GenerateTextArgs["tools"]> {
  if (input.tools.length === 0) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "language.tools needs at least one tool definition",
    })
  }
  return Object.fromEntries(
    input.tools.map((tool) => [
      tool.name,
      jsonSchemaTool({ description: tool.description, inputSchema: tool.inputSchema }),
    ])
  )
}

async function generate(
  provider: ResolvedProvider,
  input: LanguageGenerateInput,
  signal: AbortSignal | undefined,
  tools?: { tools: GenerateTextArgs["tools"]; toolChoice?: LanguageToolsInput["toolChoice"] }
): Promise<LanguageGenerateOutput> {
  const { model, handle } = modelFor(provider, input)
  const result = await generateTextGated({
    model: handle,
    ...callArgsOf(input),
    ...(tools ? { tools: tools.tools } : {}),
    ...(tools?.toolChoice ? { toolChoice: tools.toolChoice } : {}),
    ...(signal ? { abortSignal: signal } : {}),
  })
  return {
    model: result.response?.modelId ?? model,
    text: result.text,
    finishReason: finishReasonOf(result.finishReason),
    toolCalls: result.toolCalls.map((call) => ({
      id: call.toolCallId,
      name: call.toolName,
      input: (call.input ?? {}) as Record<string, unknown>,
    })),
    usage: usageOf(result.usage),
  }
}

export const languageGenerateHandler: ProviderOperationHandlerRegistration<
  LanguageGenerateInput,
  LanguageGenerateOutput
> = {
  operationId: "language.generate",
  providerMatch: { kind: "any" },
  support: "native",
  handler: ({ provider, request, signal }) => generate(provider, request.input, signal),
}

export const languageToolsHandler: ProviderOperationHandlerRegistration<
  LanguageToolsInput,
  LanguageToolsOutput
> = {
  operationId: "language.tools",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    return generate(provider, request.input, signal, {
      tools: toolsOf(request.input),
      toolChoice: request.input.toolChoice,
    })
  },
}

let streamCounter = 0

export const languageStreamHandler: ProviderOperationHandlerRegistration<
  LanguageStreamInput,
  LanguageStreamOutput
> = {
  operationId: "language.stream",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const { model, handle } = modelFor(provider, request.input)
    const result = streamTextGated({
      model: handle,
      ...callArgsOf(request.input),
      ...(signal ? { abortSignal: signal } : {}),
    })
    streamCounter += 1
    const output: LanguageStreamOutput = {
      streamId: `stream-${Date.now().toString(36)}-${streamCounter}`,
      model,
      textStream: result.textStream,
      completed: Promise.all([result.text, result.finishReason, result.usage]).then(
        ([text, finishReason, usage]) => {
          const final = {
            model,
            text,
            finishReason: finishReasonOf(finishReason),
            usage: usageOf(usage),
          }
          output.final = final
          return final
        }
      ),
    }
    return output
  },
}

function structuredOutputHandler(
  providerMatch: ProviderOperationHandlerRegistration["providerMatch"],
  support: "native" | "translated"
): ProviderOperationHandlerRegistration<
  LanguageStructuredOutputInput,
  LanguageStructuredOutputOutput
> {
  return {
    operationId: "language.structured-output",
    providerMatch,
    support,
    async handler({ provider, request, signal }) {
      const { model, handle } = modelFor(provider, request.input)
      const result = await generateObjectGated({
        model: handle,
        schema: jsonSchemaOf(request.input.schema),
        ...(request.input.schemaName ? { schemaName: request.input.schemaName } : {}),
        ...callArgsOf(request.input),
        ...(signal ? { abortSignal: signal } : {}),
      } as GenerateObjectArgs)
      return {
        model: result.response?.modelId ?? model,
        text: JSON.stringify(result.object),
        finishReason: finishReasonOf(result.finishReason),
        usage: usageOf(result.usage),
        object: result.object,
      }
    },
  }
}

export const LANGUAGE_HANDLERS: ProviderOperationHandlerRegistration[] = [
  languageGenerateHandler,
  languageStreamHandler,
  languageToolsHandler,
  structuredOutputHandler({ kind: "protocol", protocol: "anthropic" }, "translated"),
  structuredOutputHandler({ kind: "protocol", protocol: "bedrock" }, "translated"),
  structuredOutputHandler({ kind: "any" }, "native"),
] as ProviderOperationHandlerRegistration[]
