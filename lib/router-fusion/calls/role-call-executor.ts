/**
 * The provider call behind one role of a Router + Fusion run (ADR-0188 B2).
 *
 * A chat turn's model calls are the sidecar's; it owns the conversation, the
 * tools and the stream, and the ledger only gates them. A run the Run API owns
 * has no sidecar: Router + Fusion holds the whole run, so it makes the call
 * itself. This is that call — one request to one pinned deployment, with the
 * AI SDK's own retries off so every attempt is one the ledger reserved.
 *
 * It reports what the ledger needs and nothing it has to guess: the provider's
 * request id when there is one, its usage as reported, and a failure classified
 * by whether anything was actually sent.
 *
 * The step's tool policy is offered to the model as tools with **no**
 * `execute`, so the SDK hands their requests back instead of running them: a
 * model only ever asks, and the run's `ToolRuntime` decides and executes every
 * request (D26, DESIGN §11). A request whose arguments the model did not write
 * as JSON is still returned, under a key no tool declares, so the runtime
 * refuses it as `INVALID_ARGUMENTS` rather than a tool round quietly vanishing.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type {
  Message,
  RawUsage,
  RoleCallExecutor,
  RoleCallRequest,
  RoleCallResponse,
  ToolDescriptor,
  ToolIntent,
} from "@cognia/router-fusion"
import type { ModelMessage } from "ai"
import { partitionPrompt } from "@/lib/ai/prompt-partition"
import { webviewSafeTelemetry } from "@/lib/ai/webview-safe-telemetry"
import { resolveDeploymentLlmConfig } from "@/lib/ai/renderer-llm-client"
import { createTwinLanguageModel, readUsageDelta, type LlmConfig } from "@/lib/twin/distill/llm"

import { classifyUtilityFailure } from "../gate/utility-ledger"
import { AI_SDK_USAGE_SEMANTICS } from "./utility-run"

/** `providerId::modelId`, the id every route decision and ledger row uses. */
export function splitDeploymentId(
  deploymentId: string
): { providerId: string; modelId: string } | null {
  const separator = deploymentId.indexOf("::")
  if (separator <= 0 || separator === deploymentId.length - 2) return null
  return {
    providerId: deploymentId.slice(0, separator),
    modelId: deploymentId.slice(separator + 2),
  }
}

/**
 * Ask for a JSON document without touching the caller's own messages. The
 * workflow validates what comes back and never trusts the instruction to have
 * worked, so this is a request, not a guarantee.
 */
export function jsonSystemInstruction(schema: Record<string, unknown>): string {
  return [
    "Respond with a single JSON document and nothing else: no prose, no markdown fences.",
    "It must validate against this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n")
}

/** A non-negative integer from whatever the provider reported, or 0. */
function count(value: unknown): number {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

/**
 * The AI SDK's usage, in the ledger's buckets. `readUsageDelta` already
 * normalizes the older provider dialects (v6 `cachedInputTokens`, Anthropic's
 * `cacheCreationInputTokens`, the OpenAI aliases); this renames its cache
 * fields to the contract's, so nothing is silently dropped.
 *
 * `ai@7` moved the cache counts into `inputTokenDetails`, which the older
 * reader does not know about, so they are read here too — otherwise every
 * cached prompt would be billed as if it were uncached. The detail is only
 * consulted when the flat reader found nothing, so a provider that still
 * reports the old field is unchanged.
 */
export function toRawUsage(
  usage: Record<string, unknown> | undefined,
  providerMetadata: Record<string, unknown> | undefined
): RawUsage {
  const delta = readUsageDelta(usage, providerMetadata)
  const details = usage?.inputTokenDetails as Record<string, unknown> | undefined
  const cacheRead = delta.cacheReadTokens || count(details?.cacheReadTokens)
  const cacheWrite = delta.cacheCreationTokens || count(details?.cacheWriteTokens)
  return {
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/** The AI SDK's finish reasons, in the three the contract distinguishes. */
export function mapFinishReason(reason: string | undefined): "stop" | "length" | "tool_calls" {
  if (reason === "length") return "length"
  if (reason === "tool-calls" || reason === "tool_calls") return "tool_calls"
  return "stop"
}

/** Seconds or an HTTP date in a `retry-after` header, as milliseconds from now. */
export function retryAfterMs(error: unknown, now: number): number | undefined {
  const headers = (error as { responseHeaders?: Record<string, string> } | null)?.responseHeaders
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"]
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
  const at = Date.parse(raw)
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined
}

type GenerateText = typeof import("ai").generateText
type StreamText = typeof import("ai").streamText
type JsonSchemaFactory = typeof import("ai").jsonSchema
type ToolFactory = typeof import("ai").tool

export interface RoleCallExecutorDeps {
  appSettings: AppSettings
  /** Test seams; production loads the AI SDK lazily, as the rest of the app does. */
  languageModel?: (config: LlmConfig) => Promise<unknown>
  generate?: GenerateText
  stream?: StreamText
  now?: () => number
}

/**
 * The prompt, split the way `ai@7` wants it: system content travels in
 * `instructions`, and only a transcript that still holds a system turn *after*
 * its first non-system message opts back in. Passing a `{ role: "system" }`
 * entry inside `messages` is an `InvalidPromptError` in this SDK version, and
 * every role prompt starts with one (`workflows/prompting.ts`).
 *
 * The split changes nothing about who may set a system turn. A cascade or a
 * panel never forwards the caller's own messages: `taskContract()` folds them
 * into a fenced contract, so the only system content is the role prompt. A
 * direct run does forward them, and a compat caller's own system message is
 * their own prompt, reaching the provider exactly where it did before.
 *
 * Refused rather than repaired when nothing but system content is left: a call
 * with no turn to answer is a request this host will not send, and the workflow
 * sees an explicit failure instead of a provider error.
 */
export type SdkPrompt =
  { ok: true; options: ReturnType<typeof partitionPrompt> } | { ok: false; message: string }

export function sdkPrompt(
  messages: readonly Message[],
  jsonSchema?: Record<string, unknown>
): SdkPrompt {
  const partitioned = partitionPrompt(
    messages.map((message) => ({ role: message.role, content: message.content }) as ModelMessage),
    jsonSchema ? jsonSystemInstruction(jsonSchema) : undefined
  )
  if (partitioned.messages.length === 0) {
    return { ok: false, message: "a role call needs at least one non-system message" }
  }
  return { ok: true, options: partitioned }
}

/**
 * The tools this step's policy offers, as an AI SDK tool set with **no**
 * `execute`. The SDK then hands the model's request back instead of running
 * anything: the run's own `ToolRuntime` authorizes, validates and executes
 * every tool call, and records it (D26, DESIGN §11). A tool the model invents
 * is not here at all, and the runtime refuses it whatever the text asked for.
 */
export function toSdkToolSet(
  tools: readonly ToolDescriptor[],
  factories: { tool: ToolFactory; jsonSchema: JsonSchemaFactory }
): Record<string, unknown> {
  const set: Record<string, unknown> = {}
  for (const descriptor of tools) {
    set[descriptor.name] = factories.tool({
      description: descriptor.description,
      inputSchema: factories.jsonSchema(descriptor.parameters),
    })
  }
  return set
}

/**
 * Where a tool call's arguments go when the model did not produce a JSON
 * object — malformed JSON, or a literal where an object belongs. The AI SDK
 * marks the call invalid and hands back what it could read; dropping it would
 * lose the fact that a tool was requested, so it is carried under a key no
 * tool schema declares. Every tool's arguments are a strict object, so the
 * runtime refuses it as `INVALID_ARGUMENTS` and records the refusal.
 */
export const UNPARSED_TOOL_ARGUMENTS_KEY = "__unparsed_arguments__"

export function toToolArguments(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  const raw = typeof input === "string" ? input : JSON.stringify(input)
  return { [UNPARSED_TOOL_ARGUMENTS_KEY]: raw ?? null }
}

/** The model's tool requests, in the contract's shape. Nothing is executed here. */
export function toToolIntents(
  calls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>
): ToolIntent[] {
  return calls.map((call) => ({
    id: call.toolCallId,
    name: call.toolName,
    arguments: toToolArguments(call.input),
  }))
}

/**
 * A call that asked for tools finished on a tool request, whatever the
 * provider's own finish reason said: several OpenAI-compatible endpoints
 * report `stop` next to a tool call, and the workflow decides what to do from
 * this field. A truncated answer stays `length`, because the request itself may
 * be cut off and the workflow must not treat it as a complete ask.
 */
export function finishReasonWithTools(
  reason: string | undefined,
  toolCalls: readonly ToolIntent[]
): "stop" | "length" | "tool_calls" {
  const mapped = mapFinishReason(reason)
  return toolCalls.length > 0 && mapped !== "length" ? "tool_calls" : mapped
}

/**
 * A deployment the run pinned but this host cannot call — its provider was
 * switched off, its key removed, or its protocol only runs in the sidecar. It is
 * a failure of this attempt, never a quiet switch to another model (D5).
 */
const NO_CREDENTIALS = "the pinned deployment has no usable renderer credentials"

export function createRoleCallExecutor(deps: RoleCallExecutorDeps): RoleCallExecutor {
  const now = deps.now ?? (() => Date.now())
  return {
    async call(request: RoleCallRequest, signal: AbortSignal): Promise<RoleCallResponse> {
      const ref = splitDeploymentId(request.deploymentId)
      if (!ref) {
        return {
          outcome: "error",
          errorClass: "invalid_request",
          message: `unknown deployment ${request.deploymentId}`,
        }
      }
      const config = resolveDeploymentLlmConfig(
        deps.appSettings,
        ref.providerId,
        ref.modelId,
        `router-fusion:${request.role}`
      )
      if (!config) return { outcome: "error", errorClass: "auth", message: NO_CREDENTIALS }

      const prompt = sdkPrompt(request.messages, request.jsonSchema)
      if (!prompt.ok) {
        return { outcome: "error", errorClass: "invalid_request", message: prompt.message }
      }

      try {
        const sdk = await import("ai")
        const model = await (deps.languageModel ?? createTwinLanguageModel)(config)
        const offered =
          request.tools && request.tools.length > 0
            ? toSdkToolSet(request.tools, { tool: sdk.tool, jsonSchema: sdk.jsonSchema })
            : null
        const common = {
          ...prompt.options,
          maxOutputTokens: request.maxOutputTokens,
          // Every retry is an attempt the ledger reserved, or it does not happen.
          maxRetries: 0,
          // One request per call. The tools carry no `execute`, so the SDK has
          // nothing to run and nothing to feed back: a tool request ends this
          // call, and the workflow decides what the runtime does with it.
          stopWhen: sdk.isStepCount(1),
          ...(offered ? { tools: offered, toolChoice: "auto" as const } : {}),
          abortSignal: signal,
        }
        if (request.onDelta) {
          const streamText = deps.stream ?? sdk.streamText
          const result = streamText({
            ...common,
            model,
            // A failed or stopped stream must not leak the SDK's tracing
            // promise in the webview (see webview-safe-telemetry).
            telemetry: webviewSafeTelemetry(),
          } as Parameters<StreamText>[0])
          let text = ""
          for await (const delta of result.textStream) {
            text += delta
            request.onDelta(delta)
          }
          const toolCalls = toToolIntents(
            (await Promise.resolve(result.toolCalls).catch(() => [])) ?? []
          )
          return {
            outcome: "ok",
            text,
            usage: toRawUsage(
              (await Promise.resolve(result.usage).catch(() => undefined)) as
                Record<string, unknown> | undefined,
              (await Promise.resolve(result.providerMetadata).catch(() => undefined)) as
                Record<string, unknown> | undefined
            ),
            semantics: AI_SDK_USAGE_SEMANTICS,
            providerRequestId:
              (await Promise.resolve(result.response).catch(() => undefined))?.id ?? null,
            finishReason: finishReasonWithTools(
              await Promise.resolve(result.finishReason).catch(() => undefined),
              toolCalls
            ),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          }
        }
        const generateText = deps.generate ?? sdk.generateText
        const result = await generateText({ ...common, model } as Parameters<GenerateText>[0])
        const toolCalls = toToolIntents(result.toolCalls ?? [])
        return {
          outcome: "ok",
          text: result.text,
          usage: toRawUsage(
            result.usage as Record<string, unknown> | undefined,
            result.providerMetadata as Record<string, unknown> | undefined
          ),
          semantics: AI_SDK_USAGE_SEMANTICS,
          providerRequestId: result.response?.id ?? null,
          finishReason: finishReasonWithTools(result.finishReason, toolCalls),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        }
      } catch (error) {
        const errorClass = classifyUtilityFailure(error)
        const after = retryAfterMs(error, now())
        return {
          outcome: "error",
          errorClass,
          message: error instanceof Error ? error.message : String(error),
          ...(after !== undefined ? { retryAfterMs: after } : {}),
        }
      }
    },
  }
}
