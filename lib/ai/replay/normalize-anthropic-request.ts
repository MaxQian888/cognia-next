/**
 * Anthropic Messages wire payload → the digestable request surface (ADR-0118).
 *
 * This is the hinge of runtime replay. At record time a digest is computed from
 * what the SDK sent; at replay time the tape server recomputes it from what the
 * SDK sends again and looks up a tape. If the two normalizations disagree by
 * one field, every tape misses and the suite fails for a reason that looks
 * nothing like the cause — so normalization lives in ONE function used by both
 * sides, and everything it drops is justified below.
 *
 * Dropped because it cannot change the model's answer:
 *
 *   - `metadata` — carries `user_id`. Including it would both break matching
 *     across users and put an identifier into a committed fixture.
 *   - `cache_control` markers — prompt-cache breakpoints are a billing and
 *     latency concern; the same conversation with and without them is the same
 *     question.
 *   - `stream` — the same request answered as a stream or as one body is the
 *     same request. The tape carries the behaviour; the digest carries the ask.
 *
 * Everything else is kept, including tool ORDER, which providers are sensitive
 * to.
 */

import { digestPrompt, digestToolSurface, digestValue } from "@/lib/agent/composition/digest"
import type { Sha256Hex, ToolSurfaceEntry } from "@/lib/agent/composition/digest"
import { requestDigestPayload } from "@cognia/agent-config-types/model-request-surface"
import type {
  ModelRequestConfigV1,
  ModelRequestPurpose,
} from "@cognia/agent-config-types/model-request-surface"

/** The subset of `POST /v1/messages` that participates in identity. */
export interface AnthropicMessagesPayload {
  model?: unknown
  system?: unknown
  messages?: unknown
  tools?: unknown
  tool_choice?: unknown
  temperature?: unknown
  top_p?: unknown
  max_tokens?: unknown
  stop_sequences?: unknown
  stream?: unknown
  thinking?: unknown
  metadata?: unknown
}

export interface NormalizedAnthropicRequest {
  model: string
  /** Flattened system prompt; `""` when the request carried none. */
  system: string
  messages: unknown[]
  tools: ToolSurfaceEntry[]
  config: ModelRequestConfigV1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Recursively drop `cache_control` from content blocks.
 *
 * Written as a copy rather than a mutation because the payload belongs to the
 * caller — normalizing a live request must not change what actually gets sent.
 */
function stripCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCacheControl)
  if (!isRecord(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (key === "cache_control") continue
    if (child === undefined) continue
    out[key] = stripCacheControl(child)
  }
  return out
}

/**
 * Flatten a system prompt to text.
 *
 * Anthropic accepts either a string or an array of text blocks, and the SDK
 * switches between them depending on whether prompt caching is on. Both forms
 * describe the same instructions, so both must digest the same.
 */
export function flattenSystemPrompt(system: unknown): string {
  if (typeof system === "string") return system
  if (!Array.isArray(system)) return ""
  return system
    .map((block) => {
      if (typeof block === "string") return block
      if (isRecord(block) && typeof block.text === "string") return block.text
      return ""
    })
    .join("")
}

/** Tool definitions in the order the provider received them. */
export function normalizeTools(tools: unknown): ToolSurfaceEntry[] {
  if (!Array.isArray(tools)) return []
  return tools.map((tool, index) => {
    const record = isRecord(tool) ? tool : {}
    const name = typeof record.name === "string" ? record.name : `tool_${index}`
    return {
      name,
      schema: stripCacheControl(record.input_schema ?? record.inputSchema ?? null),
      visibility: "native" as const,
    }
  })
}

function normalizeConfig(payload: AnthropicMessagesPayload): ModelRequestConfigV1 {
  const config: ModelRequestConfigV1 = {}
  if (typeof payload.temperature === "number") config.temperature = payload.temperature
  if (typeof payload.top_p === "number") config.topP = payload.top_p
  if (typeof payload.max_tokens === "number") config.maxOutputTokens = payload.max_tokens
  if (Array.isArray(payload.stop_sequences)) {
    config.stopSequences = payload.stop_sequences.filter(
      (entry): entry is string => typeof entry === "string"
    )
  }
  if (isRecord(payload.thinking) && typeof payload.thinking.budget_tokens === "number") {
    config.thinkingBudgetTokens = payload.thinking.budget_tokens
  }
  if (typeof payload.tool_choice === "string") {
    config.toolChoice = payload.tool_choice
  } else if (isRecord(payload.tool_choice) && typeof payload.tool_choice.type === "string") {
    config.toolChoice =
      typeof payload.tool_choice.name === "string"
        ? `${payload.tool_choice.type}:${payload.tool_choice.name}`
        : payload.tool_choice.type
  }
  return config
}

export function normalizeAnthropicRequest(
  payload: AnthropicMessagesPayload
): NormalizedAnthropicRequest {
  return {
    model: typeof payload.model === "string" ? payload.model : "",
    system: flattenSystemPrompt(payload.system),
    messages: Array.isArray(payload.messages)
      ? (stripCacheControl(payload.messages) as unknown[])
      : [],
    tools: normalizeTools(payload.tools),
    config: normalizeConfig(payload),
  }
}

export interface RequestDigestSet {
  promptDigest: string
  messagesDigest: string
  toolDigest: string
  requestDigest: string
}

/**
 * The four digests a surface and a tape match on.
 *
 * `provider` is a parameter rather than being read from the payload because the
 * wire format does not carry it — the same Anthropic-shaped body can be served
 * by Anthropic, Bedrock or a gateway, and those are not interchangeable
 * recordings.
 */
export async function computeRequestDigests(
  normalized: NormalizedAnthropicRequest,
  options: { provider: string; purpose: ModelRequestPurpose; hash?: Sha256Hex }
): Promise<RequestDigestSet> {
  const [promptDigest, messagesDigest, toolDigest] = await Promise.all([
    digestPrompt(normalized.system, options.hash),
    digestValue(normalized.messages, options.hash),
    digestToolSurface(normalized.tools, options.hash),
  ])

  const requestDigest = await digestValue(
    requestDigestPayload({
      provider: options.provider,
      model: normalized.model,
      purpose: options.purpose,
      config: normalized.config,
      promptDigest,
      messagesDigest,
      toolDigest,
    }),
    options.hash
  )

  return { promptDigest, messagesDigest, toolDigest, requestDigest }
}

/** Normalize and digest in one step — what both the recorder and server call. */
export async function digestAnthropicRequest(
  payload: AnthropicMessagesPayload,
  options: { provider: string; purpose: ModelRequestPurpose; hash?: Sha256Hex }
): Promise<RequestDigestSet & { normalized: NormalizedAnthropicRequest }> {
  const normalized = normalizeAnthropicRequest(payload)
  return { normalized, ...(await computeRequestDigests(normalized, options)) }
}
