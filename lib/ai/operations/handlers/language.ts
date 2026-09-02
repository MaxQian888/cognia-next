/**
 * `language.generate`, `language.stream`, `language.tools` and
 * `language.structured-output`, all through the gated AI SDK surface over
 * the same model handle the chat path builds (`createFeatureProviderModel`).
 * Structured output is registered as `translated` on the Anthropic and
 * Bedrock protocols, where the SDK emulates a schema through a tool call,
 * and `native` elsewhere.
 */

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

export interface LanguageMessage {
  role: "system" | "user" | "assistant"
  content: string
}

export interface LanguageToolDefinition {
  description?: string
  inputSchema: Record<string, unknown>
}

export interface LanguageInput {
  model?: string
  prompt?: string
  system?: string
  messages?: LanguageMessage[]
  maxOutputTokens?: number
  temperature?: number
  /** `language.tools` only: tool name to JSON-schema definition. */
  tools?: Record<string, LanguageToolDefinition>
  /** `language.structured-output` only: the JSON schema of the object. */
  schema?: Record<string, unknown>
}

export interface LanguageUsage {
  inputTokens: number
  outputTokens: number
}

export interface LanguageToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

export interface LanguageGenerateOutput {
  text: string
  finishReason: string
  usage: LanguageUsage
  toolCalls: LanguageToolCall[]
}

export interface LanguageStreamOutput {
  textStream: AsyncIterable<string>
  finished: Promise<Omit<LanguageGenerateOutput, "toolCalls">>
}

export interface LanguageStructuredOutput {
  object: unknown
  usage: LanguageUsage
}

type PromptArgs =
  { prompt: string; system?: string } | { messages: PromptMessages; system?: string }

/** The prompt half of a call. A request must carry a prompt or messages. */
export function promptArgsOf(input: LanguageInput): PromptArgs {
  if (input.messages?.length) {
    return {
      messages: input.messages.map((message) => ({ role: message.role, content: message.content })),
      ...(input.system ? { system: input.system } : {}),
    }
  }
  if (typeof input.prompt === "string" && input.prompt.length > 0) {
    return { prompt: input.prompt, ...(input.system ? { system: input.system } : {}) }
  }
  throw new ProviderOperationFailureError({
    code: "schema",
    retryable: false,
    message: "a language request needs a prompt or messages",
  })
}

function usageOf(
  usage: { inputTokens?: number; outputTokens?: number } | undefined
): LanguageUsage {
  return { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 }
}

function settingsOf(
  input: LanguageInput
): Pick<GenerateTextArgs, "maxOutputTokens" | "temperature"> {
  return {
    ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  }
}

function modelFor(provider: ResolvedProvider, input: LanguageInput) {
  const model = requireModelId(provider, input.model)
  return createFeatureProviderModel({ ...provider, model })
}

function toolsOf(input: LanguageInput): NonNullable<GenerateTextArgs["tools"]> {
  const entries = Object.entries(input.tools ?? {})
  if (entries.length === 0) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: "language.tools needs at least one tool definition",
    })
  }
  return Object.fromEntries(entries.map(([name, definition]) => [name, jsonSchemaTool(definition)]))
}

async function generate(
  provider: ResolvedProvider,
  input: LanguageInput,
  signal: AbortSignal | undefined,
  tools?: GenerateTextArgs["tools"]
): Promise<LanguageGenerateOutput> {
  const result = await generateTextGated({
    model: modelFor(provider, input),
    ...promptArgsOf(input),
    ...settingsOf(input),
    ...(tools ? { tools } : {}),
    ...(signal ? { abortSignal: signal } : {}),
  })
  return {
    text: result.text,
    finishReason: result.finishReason,
    usage: usageOf(result.usage),
    toolCalls: result.toolCalls.map((call) => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    })),
  }
}

export const languageGenerateHandler: ProviderOperationHandlerRegistration<
  LanguageInput,
  LanguageGenerateOutput
> = {
  operationId: "language.generate",
  providerMatch: { kind: "any" },
  support: "native",
  handler: ({ provider, request, signal }) => generate(provider, request.input, signal),
}

export const languageToolsHandler: ProviderOperationHandlerRegistration<
  LanguageInput,
  LanguageGenerateOutput
> = {
  operationId: "language.tools",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    return generate(provider, request.input, signal, toolsOf(request.input))
  },
}

export const languageStreamHandler: ProviderOperationHandlerRegistration<
  LanguageInput,
  LanguageStreamOutput
> = {
  operationId: "language.stream",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const result = streamTextGated({
      model: modelFor(provider, request.input),
      ...promptArgsOf(request.input),
      ...settingsOf(request.input),
      ...(signal ? { abortSignal: signal } : {}),
    })
    const finished = Promise.all([result.text, result.finishReason, result.usage]).then(
      ([text, finishReason, usage]) => ({ text, finishReason, usage: usageOf(usage) })
    )
    return { textStream: result.textStream, finished }
  },
}

function structuredOutputHandler(
  providerMatch: ProviderOperationHandlerRegistration["providerMatch"],
  support: "native" | "translated"
): ProviderOperationHandlerRegistration<LanguageInput, LanguageStructuredOutput> {
  return {
    operationId: "language.structured-output",
    providerMatch,
    support,
    async handler({ provider, request, signal }) {
      if (!request.input.schema) {
        throw new ProviderOperationFailureError({
          code: "schema",
          retryable: false,
          message: "language.structured-output needs a JSON schema",
        })
      }
      const result = await generateObjectGated({
        model: modelFor(provider, request.input),
        schema: jsonSchemaOf(request.input.schema),
        ...promptArgsOf(request.input),
        ...settingsOf(request.input),
        ...(signal ? { abortSignal: signal } : {}),
      } as GenerateObjectArgs)
      return { object: result.object, usage: usageOf(result.usage) }
    },
  }
}

export const LANGUAGE_HANDLERS = [
  languageGenerateHandler,
  languageStreamHandler,
  languageToolsHandler,
  structuredOutputHandler({ kind: "protocol", protocol: "anthropic" }, "translated"),
  structuredOutputHandler({ kind: "protocol", protocol: "bedrock" }, "translated"),
  structuredOutputHandler({ kind: "any" }, "native"),
]
