// Conversation compaction for the non-Anthropic (AI SDK) path.
//
// The Anthropic Agent SDK auto-compacts the conversation when the context
// window fills; the AI SDK path (`ai-sdk.mjs`) keeps a flat `conversation`
// array that grows unbounded across turns and eventually overflows the model.
// This module gives that path parity: detect the threshold from the last
// turn's real input-token count, summarize the older messages, and splice the
// summary in ahead of the recent turns.
//
// The sidecar can NOT import `lib/` (build boundary), so the threshold and the
// context-window table are mirrored from `lib/claude/usage.ts` — keep them in
// sync. The table only needs the families the AI SDK path actually drives
// (OpenAI / Google / Mistral / Cohere / local OpenAI-compatible engines); the
// Anthropic families are included for completeness since a custom provider can
// declare the anthropic protocol.

/** Mirrors `lib/claude/usage.ts:AUTO_COMPACT_FRACTION`. */
export const AUTO_COMPACT_FRACTION = 0.835

/** Safe default window for an unknown / unrecognised model id (conservative). */
const DEFAULT_CONTEXT_WINDOW = 128_000

// First match wins; mirrors the ordering in `lib/claude/usage.ts`.
const MODEL_CONTEXT_WINDOWS = [
  [/\[1m\]/i, 1_000_000],
  [/[-._]1m(\b|$)/i, 1_000_000],
  [/claude-opus-4-(6|7|8)/i, 1_000_000],
  [/claude-sonnet-4-(6|7|8)/i, 1_000_000],
  [/claude-(opus|sonnet|haiku)/i, 200_000],
  [/gpt-4o/i, 128_000],
  [/gpt-4\.1/i, 1_000_000],
  [/(^|[^a-z])o[134]([^a-z]|$)/i, 200_000],
  [/gemini-(1\.5|2\.5|3)/i, 1_000_000],
  // DeepSeek's chat/reasoner models expose a 64k window.
  [/deepseek/i, 64_000],
]

/** Context-window size for a model id (mirrors the renderer's table). */
export function getContextWindow(modelId) {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW
  for (const [pattern, window] of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return window
  }
  return DEFAULT_CONTEXT_WINDOW
}

function textLength(content) {
  if (typeof content === "string") return content.length
  if (Array.isArray(content)) {
    let n = 0
    for (const part of content) {
      if (typeof part === "string") n += part.length
      else if (part && typeof part.text === "string") n += part.text.length
    }
    return n
  }
  return 0
}

/**
 * Rough token estimate for a message list (≈4 chars/token). Only used for the
 * informational before/after figures on the boundary marker — the compaction
 * TRIGGER uses the provider's real `usage.inputTokens`, not this.
 */
export function estimateTokens(messages) {
  let chars = 0
  for (const m of messages) chars += textLength(m?.content)
  return Math.round(chars / 4)
}

/**
 * Should the next turn compact first? Fires when the last turn's real input
 * token count crossed the auto-compact fraction of the model's window.
 */
export function shouldCompact({ lastInputTokens, modelId, fraction = AUTO_COMPACT_FRACTION }) {
  if (typeof lastInputTokens !== "number" || lastInputTokens <= 0) return false
  const window = getContextWindow(modelId)
  return lastInputTokens >= window * fraction
}

/**
 * Split the conversation into the leading system block (`head`), the older
 * user/assistant messages to summarize (`middle`), and the most recent
 * messages to keep verbatim (`tail`). Returns null when there is nothing old
 * enough to be worth summarizing.
 *
 * @param {{ conversation: Array<{role:string, content:any}>, keepRecentMessages: number }} p
 */
export function planCompaction({ conversation, keepRecentMessages }) {
  let headEnd = 0
  while (headEnd < conversation.length && conversation[headEnd].role === "system") headEnd++
  const head = conversation.slice(0, headEnd)
  const rest = conversation.slice(headEnd)
  const keep = Math.max(0, keepRecentMessages)
  if (rest.length <= keep) return null
  const middle = rest.slice(0, rest.length - keep)
  const tail = rest.slice(rest.length - keep)
  if (middle.length === 0) return null
  return { head, middle, tail }
}

/**
 * Rebuild the conversation as `head` + a single summary user message + `tail`.
 * Returns the original array unchanged when there is nothing to compact.
 */
export function applyCompaction({ conversation, keepRecentMessages, summary }) {
  const plan = planCompaction({ conversation, keepRecentMessages })
  if (!plan) return conversation
  const summaryMessage = {
    role: "user",
    content: `<conversation-summary>\nSummary of earlier conversation (compacted to save context):\n${summary}\n</conversation-summary>`,
  }
  return [...plan.head, summaryMessage, ...plan.tail]
}
