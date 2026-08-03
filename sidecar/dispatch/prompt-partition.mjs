// Prompt partitioning for the AI SDK `system` / `instructions` split.
//
// AI SDK 7 rejects `{ role: "system" }` entries inside `prompt` / `messages` by
// default: system content must travel in the top-level instructions option, and
// anything left inline has to be opted back in with `allowSystemInMessages`.
// `dispatch/ai-sdk.mjs` builds one flat conversation with the system prompt at
// the head, so the split happens here, at the `streamText` boundary — the
// compaction / tool-pairing pipeline keeps operating on the combined array and
// needs no changes.
//
// This is the behaviour-identical port of `lib/ai/prompt-partition.ts` (the
// sidecar is a standalone Node project and cannot import `@/` paths). Both are
// pinned by the same table of cases — keep them in lockstep.
//
// Anthropic prompt caching depends on this being lossless: `ai-sdk.mjs` plants
// up to three `cacheControl` breakpoints on separate leading system messages and
// each must arrive with its own `providerOptions` intact.

/**
 * The option key the partition result is emitted under.
 *
 * `ai@7` renamed `system` to `instructions`; `system` survives only as a
 * deprecated alias and will be dropped in the next major. Exported so the tests
 * can pin it — a silent revert here would send system content back into a key
 * the SDK no longer treats as canonical.
 */
export const EMITTED_INSTRUCTIONS_KEY = "instructions"

/**
 * @typedef {{ role: string, content: any, providerOptions?: any }} AnyMessage
 * @typedef {{ role: "system", content: string, providerOptions?: any }} SystemMessage
 */

/**
 * @param {AnyMessage} message
 * @returns {boolean}
 */
function isSystemMessage(message) {
  return Boolean(message) && message.role === "system"
}

/**
 * Normalize free-form leading instructions into an array of system messages.
 * Empty / whitespace-only entries are dropped so an unset system prompt never
 * turns into an empty system turn.
 *
 * @param {string|SystemMessage|ReadonlyArray<SystemMessage>|null|undefined} instructions
 * @returns {SystemMessage[]}
 */
function toSystemMessages(instructions) {
  if (instructions === null || instructions === undefined) return []
  if (typeof instructions === "string") {
    return instructions.trim().length > 0 ? [{ role: "system", content: instructions }] : []
  }
  const list = Array.isArray(instructions) ? instructions : [instructions]
  return list.filter(
    (message) => typeof message?.content === "string" && message.content.trim().length > 0
  )
}

/**
 * Split a flat conversation into top-level system instructions plus the
 * remaining turns.
 *
 * - The LEADING RUN of system messages is hoisted, in order, into `system`.
 * - `leadingInstructions` is prepended ahead of them.
 * - System messages appearing AFTER the first non-system turn stay where they
 *   are and `allowSystemInMessages` is set, preserving the exact order the model
 *   previously saw. Every producer here is trusted first-party code; never widen
 *   this to user-authored message arrays.
 *
 * The result is spreadable straight into `streamText` options.
 *
 * @param {ReadonlyArray<AnyMessage>} messages
 * @param {string|SystemMessage|ReadonlyArray<SystemMessage>} [leadingInstructions]
 * @returns {{ instructions?: SystemMessage[], messages: AnyMessage[], allowSystemInMessages?: true }}
 */
export function partitionPrompt(messages, leadingInstructions) {
  const list = Array.isArray(messages) ? messages : []
  let firstNonSystem = 0
  while (firstNonSystem < list.length && isSystemMessage(list[firstNonSystem])) {
    firstNonSystem += 1
  }

  const instructions = [
    ...toSystemMessages(leadingInstructions),
    ...toSystemMessages(list.slice(0, firstNonSystem)),
  ]
  const rest = list.slice(firstNonSystem)

  return {
    ...(instructions.length > 0 ? { [EMITTED_INSTRUCTIONS_KEY]: instructions } : {}),
    messages: rest,
    ...(rest.some(isSystemMessage) ? { allowSystemInMessages: true } : {}),
  }
}
