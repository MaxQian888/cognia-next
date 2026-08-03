/**
 * Prompt partitioning for the AI SDK `system` / `instructions` split.
 *
 * AI SDK 7 rejects `{ role: "system" }` entries inside `prompt` / `messages` by
 * default: system content must travel in the top-level instructions option, and
 * anything left inline has to be explicitly opted back in with
 * `allowSystemInMessages`. Several of our call sites (the sidecar dispatcher, the
 * plugin AI API, the VS Code LM shim) build one flat `ModelMessage[]` with the
 * system prompt at the head, so they all need the same split.
 *
 * This helper is that single split. It is deliberately shaped as a
 * **spreadable options fragment** so call sites read as:
 *
 * ```ts
 * streamText({ model, ...partitionPrompt(messages, systemString), abortSignal })
 * ```
 *
 * The emitted key is `instructions`, the canonical AI SDK 7 name. It takes
 * `string | SystemModelMessage | Array<SystemModelMessage>`, so per-message
 * `providerOptions` survive. (`system` still works as a deprecated alias and is
 * scheduled for removal in the next major.) Because every call site spreads this
 * result, the key lives in exactly one place per port — see
 * `EMITTED_INSTRUCTIONS_KEY` below.
 *
 * Anthropic prompt caching depends on this being lossless: the sidecar plants up
 * to three `cacheControl` breakpoints on separate leading system messages
 * (`sidecar/dispatch/ai-sdk.mjs`), and each one must arrive with its own
 * `providerOptions` intact.
 *
 * The sidecar cannot import `@/` paths, so it carries a behaviour-identical
 * `.mjs` port at `sidecar/dispatch/prompt-partition.mjs`. Both are pinned by the
 * same table of cases — keep them in lockstep.
 */

import type { ModelMessage, SystemModelMessage } from "ai"

/**
 * The option key the partition result is emitted under.
 *
 * `ai@7` renamed `system` to `instructions`; `system` survives only as a
 * deprecated alias and will be dropped in the next major. Exported so the tests
 * can pin it — a silent revert here would send system content back into a key
 * the SDK no longer treats as canonical.
 */
export const EMITTED_INSTRUCTIONS_KEY = "instructions" as const

export interface PartitionedPrompt {
  /**
   * Leading system content, one entry per original system message so
   * `providerOptions` (Anthropic `cacheControl` breakpoints) stay attached to the
   * exact segment they were placed on. Absent when there is no system content.
   */
  instructions?: SystemModelMessage[]
  /** The conversation with the leading system run removed. */
  messages: ModelMessage[]
  /**
   * Only set when system messages survive *inside* `messages` — i.e. they were
   * interleaved with the history rather than sitting at the head, so hoisting
   * them would reorder what the model sees.
   *
   * Every producer of these messages is trusted first-party code (the sidecar
   * prompt builder, the plugin host, the LM shim); none of them splice
   * user-authored text in as a system turn. Do not widen this to
   * user-controlled message arrays — a user-settable system message is a prompt
   * injection primitive.
   */
  allowSystemInMessages?: true
}

function isSystemMessage(message: ModelMessage): message is SystemModelMessage {
  return message.role === "system"
}

/**
 * Normalize free-form leading instructions into `SystemModelMessage[]`.
 * `undefined` / empty / whitespace-only entries are dropped so an unset system
 * prompt never turns into an empty system turn.
 */
function toSystemMessages(
  instructions: string | SystemModelMessage | readonly SystemModelMessage[] | undefined
): SystemModelMessage[] {
  if (instructions == null) return []
  if (typeof instructions === "string") {
    return instructions.trim().length > 0 ? [{ role: "system", content: instructions }] : []
  }
  const list = Array.isArray(instructions) ? instructions : [instructions as SystemModelMessage]
  return list.filter((message) => message.content.trim().length > 0)
}

/**
 * Split a flat conversation into top-level system instructions plus the
 * remaining turns.
 *
 * - The **leading run** of system messages is hoisted, in order, into `system`.
 * - `leadingInstructions` (a separately-carried system prompt, e.g. our
 *   `composeSystem()` output) is prepended ahead of them.
 * - System messages that appear *after* the first non-system turn are left where
 *   they are and `allowSystemInMessages` is set, preserving the exact order the
 *   model previously saw.
 *
 * The result is spreadable straight into `generateText` / `streamText` options.
 */
export function partitionPrompt(
  messages: readonly ModelMessage[],
  leadingInstructions?: string | SystemModelMessage | readonly SystemModelMessage[]
): PartitionedPrompt {
  let firstNonSystem = 0
  while (firstNonSystem < messages.length && isSystemMessage(messages[firstNonSystem]!)) {
    firstNonSystem += 1
  }

  const instructions = [
    ...toSystemMessages(leadingInstructions),
    ...toSystemMessages(messages.slice(0, firstNonSystem) as SystemModelMessage[]),
  ]
  const rest = messages.slice(firstNonSystem)

  return {
    ...(instructions.length > 0 ? { instructions } : {}),
    messages: rest as ModelMessage[],
    ...(rest.some(isSystemMessage) ? { allowSystemInMessages: true as const } : {}),
  }
}
