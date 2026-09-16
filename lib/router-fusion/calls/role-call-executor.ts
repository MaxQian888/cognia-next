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
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type {
  Message,
  RawUsage,
  RoleCallExecutor,
  RoleCallRequest,
  RoleCallResponse,
} from "@cognia/router-fusion"
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

/**
 * The AI SDK's usage, in the ledger's buckets. `readUsageDelta` already
 * normalizes the provider dialects (v6 `cachedInputTokens`, Anthropic's
 * `cacheCreationInputTokens`, the OpenAI aliases); this only renames its cache
 * fields to the contract's, so nothing is silently dropped.
 */
export function toRawUsage(
  usage: Record<string, unknown> | undefined,
  providerMetadata: Record<string, unknown> | undefined
): RawUsage {
  const delta = readUsageDelta(usage, providerMetadata)
  return {
    inputTokens: delta.inputTokens,
    outputTokens: delta.outputTokens,
    ...(delta.cacheReadTokens > 0 ? { cacheReadTokens: delta.cacheReadTokens } : {}),
    ...(delta.cacheCreationTokens > 0 ? { cacheWriteTokens: delta.cacheCreationTokens } : {}),
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

export interface RoleCallExecutorDeps {
  appSettings: AppSettings
  /** Test seams; production loads the AI SDK lazily, as the rest of the app does. */
  languageModel?: (config: LlmConfig) => Promise<unknown>
  generate?: GenerateText
  stream?: StreamText
  now?: () => number
}

function toSdkMessages(messages: Message[]): { role: string; content: string }[] {
  return messages.map((message) => ({ role: message.role, content: message.content }))
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

      const messages = toSdkMessages(request.messages)
      if (request.jsonSchema) {
        messages.unshift({ role: "system", content: jsonSystemInstruction(request.jsonSchema) })
      }
      const common = {
        messages,
        maxOutputTokens: request.maxOutputTokens,
        // Every retry is an attempt the ledger reserved, or it does not happen.
        maxRetries: 0,
        abortSignal: signal,
      }

      try {
        const model = await (deps.languageModel ?? createTwinLanguageModel)(config)
        if (request.onDelta) {
          const streamText = deps.stream ?? (await import("ai")).streamText
          const result = streamText({ ...common, model } as Parameters<StreamText>[0])
          let text = ""
          for await (const delta of result.textStream) {
            text += delta
            request.onDelta(delta)
          }
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
            finishReason: mapFinishReason(
              await Promise.resolve(result.finishReason).catch(() => undefined)
            ),
          }
        }
        const generateText = deps.generate ?? (await import("ai")).generateText
        const result = await generateText({ ...common, model } as Parameters<GenerateText>[0])
        return {
          outcome: "ok",
          text: result.text,
          usage: toRawUsage(
            result.usage as Record<string, unknown> | undefined,
            result.providerMetadata as Record<string, unknown> | undefined
          ),
          semantics: AI_SDK_USAGE_SEMANTICS,
          providerRequestId: result.response?.id ?? null,
          finishReason: mapFinishReason(result.finishReason),
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
