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

/**
 * Safe default window for an unknown / unrecognised model id (conservative).
 * Mirrors `lib/claude/usage.ts:DEFAULT_CONTEXT_WINDOW`; exported so the parity
 * test (`lib/claude/usage.compaction-parity.test.ts`) can assert agreement.
 */
export const DEFAULT_CONTEXT_WINDOW = 128_000

// First match wins; mirrors the ordering in `lib/claude/usage.ts`.
const MODEL_CONTEXT_WINDOWS = [
  [/\[1m\]/i, 1_000_000],
  [/[-._]1m(\b|$)/i, 1_000_000],
  [/claude-opus-4-(6|7|8)/i, 1_000_000],
  [/claude-sonnet-4-(6|7|8)/i, 1_000_000],
  // Matches family-first (`claude-sonnet-4-5`) and version-first 3.x
  // (`claude-3-5-sonnet`, `claude-3-opus`); 1M-tier patterns above win first.
  [/claude(-[\d.]+)*-(opus|sonnet|haiku)/i, 200_000],
  [/gpt-4o/i, 128_000],
  [/gpt-4\.1/i, 1_000_000],
  [/(^|[^a-z])o[134]([^a-z]|$)/i, 200_000],
  [/gemini-(1\.5|2\.5|3)/i, 1_000_000],
  // DeepSeek V3 / V3.1 (deepseek-chat, deepseek-reasoner) expose a 128k window.
  [/deepseek/i, 128_000],
]

/** Context-window size for a model id (mirrors the renderer's table). */
export function getContextWindow(modelId) {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW
  for (const [pattern, window] of MODEL_CONTEXT_WINDOWS) {
    if (pattern.test(modelId)) return window
  }
  return DEFAULT_CONTEXT_WINDOW
}

/** Character size of a structured tool-result body (string | text-part array |
 * arbitrary object). Bounded, non-throwing. */
function toolBodyLength(body) {
  if (body == null) return 0
  if (typeof body === "string") return body.length
  if (Array.isArray(body)) {
    let n = 0
    for (const b of body) n += toolBodyLength(b)
    return n
  }
  if (typeof body === "object") {
    if (typeof body.text === "string") return body.text.length
    if ("value" in body) return toolBodyLength(body.value)
    try {
      return JSON.stringify(body).length
    } catch {
      return 0
    }
  }
  return String(body).length
}

function textLength(content) {
  if (typeof content === "string") return content.length
  if (Array.isArray(content)) {
    let n = 0
    for (const part of content) {
      if (typeof part === "string") n += part.length
      else if (part && typeof part.text === "string") n += part.text.length
      else if (part && typeof part === "object") {
        // Tool-result parts keep their body in `output` / `result` / `content`
        // rather than `text`; counting them 0 systematically undercounted
        // tool-heavy conversations (the drain-line then evicted too little).
        n += toolBodyLength(part.output ?? part.result ?? part.content)
      }
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
 * Should the next turn compact first?
 *
 * - `trigger === "manual"` → never auto-fires (manual compaction uses `force`).
 * - `trigger === "message-count"` → fires when `messageCount` reaches the
 *   configured `messageCountThreshold` (token-independent).
 * - otherwise (token-threshold / default) → fires when the last turn's real
 *   input token count crossed the auto-compact fraction of the model's window.
 *
 * `contextWindow` is the AUTHORITATIVE window the renderer resolved from the
 * provider catalog (`resolveSendOptions` → `SendOptions.compaction.contextWindow`).
 * Prefer it over {@link getContextWindow}'s regex table: that table is a
 * conservative mirror that drifts (e.g. it floors every `deepseek*` id at 128k,
 * so a real 1M deepseek-v4 would auto-compact at ~107k instead of ~835k). The
 * regex window is only the fallback for callers that don't thread the resolved
 * value (older sessions, the parity test).
 */
export function shouldCompact({
  lastInputTokens,
  modelId,
  contextWindow,
  fraction = AUTO_COMPACT_FRACTION,
  trigger,
  messageCount,
  messageCountThreshold,
}) {
  if (trigger === "manual") return false
  if (trigger === "message-count") {
    if (typeof messageCount !== "number" || typeof messageCountThreshold !== "number") return false
    return messageCountThreshold > 0 && messageCount >= messageCountThreshold
  }
  if (typeof lastInputTokens !== "number" || lastInputTokens <= 0) return false
  const window =
    typeof contextWindow === "number" && contextWindow > 0
      ? contextWindow
      : getContextWindow(modelId)
  return lastInputTokens >= window * fraction
}

// --- Frozen-summary markers ------------------------------------------------
// A compaction summary is spliced as a `role:"user"` message whose text opens
// with a sentinel tag carrying a monotonically-increasing version. Marking it
// lets `planCompaction` PROTECT prior summaries (keep them in the head instead
// of feeding them back into `middle`), which is what stops the lossy
// "summary-of-summary" recursion and keeps the prompt-cache prefix stable.

/** Sentinel prefix every spliced summary message opens with. */
export const SUMMARY_OPEN_TAG = "<conversation-summary"

/** Leading text of a summary/optical message (the sentinel-bearing header),
 * whether content is a plain string or a `[text, …image]` array (the optical
 * strategy renders the archive as image parts after the header). */
function leadingText(m) {
  if (!m || m.role !== "user") return null
  if (typeof m.content === "string") return m.content
  if (Array.isArray(m.content)) {
    const first = m.content.find((p) => p && p.type === "text" && typeof p.text === "string")
    return first ? first.text : null
  }
  return null
}

/** True when `m` is a previously-spliced compaction summary OR optical archive.
 * Both are protected as frozen so prior archives are carried forward verbatim
 * instead of being fed back into `middle` (and, for optical, silently lost — an
 * image part yields no text to re-summarize). */
export function isSummaryMessage(m) {
  const head = leadingText(m)
  return head != null && head.startsWith(SUMMARY_OPEN_TAG)
}

/** True when the frozen artifact is an optical (image-bearing) archive. */
export function isOpticalMessage(m) {
  return (
    isSummaryMessage(m) &&
    Array.isArray(m.content) &&
    m.content.some((p) => p && p.type === "image")
  )
}

/** Version parsed from a summary/optical message's `v="N"` header (0 absent). */
export function summaryVersion(m) {
  if (!isSummaryMessage(m)) return 0
  const match = leadingText(m).match(/^<conversation-summary\s+v="(\d+)"/)
  return match ? Number(match[1]) : 0
}

/** Render one versioned, prefix-cache-stable summary message. */
export function makeSummaryMessage(summary, version) {
  const v = Number.isFinite(version) && version > 0 ? version : 1
  return {
    role: "user",
    content: `${SUMMARY_OPEN_TAG} v="${v}">\nSummary of earlier conversation (compacted to save context):\n${summary}\n</conversation-summary>`,
  }
}

/**
 * Render one versioned optical-archive message: a sentinel-bearing text header
 * followed by the rendered image parts. Recognized as frozen by
 * {@link isSummaryMessage}, so it is carried forward verbatim across turns.
 * @param {Array<{type:"image", image:string, mediaType?:string}>} imageParts
 * @param {{ messageCount?:number, frameCount?:number }} info
 * @param {number} version
 */
export function makeOpticalMessage(imageParts, info, version) {
  const v = Number.isFinite(version) && version > 0 ? version : 1
  const frames = imageParts.length
  const msgs = info?.messageCount
  const header =
    `${SUMMARY_OPEN_TAG} v="${v}" optical="1">\n` +
    `Earlier conversation${typeof msgs === "number" ? ` (${msgs} messages)` : ""} was compacted to ` +
    `save context: it is rendered as ${frames} optical frame image${frames === 1 ? "" : "s"} below. ` +
    `Read the image${frames === 1 ? "" : "s"} as verbatim conversation history and treat it as authoritative.\n` +
    `</conversation-summary>`
  return { role: "user", content: [{ type: "text", text: header }, ...imageParts] }
}

/**
 * Split the conversation into:
 *  - `systemHead` — the leading `role:"system"` block (never summarized),
 *  - `frozen` — the contiguous prior summary messages right after it (PROTECTED;
 *    carried forward verbatim, never re-summarized),
 *  - `middle` — the genuinely-new user/assistant messages to summarize,
 *  - `tail` — the most-recent `keepRecentMessages` kept verbatim.
 * `head` = `systemHead` + `frozen` (kept for back-compat). Returns null when
 * there is nothing new enough to be worth summarizing.
 *
 * @param {{ conversation: Array<{role:string, content:any}>, keepRecentMessages: number }} p
 */
export function planCompaction({ conversation, keepRecentMessages }) {
  let i = 0
  while (i < conversation.length && conversation[i].role === "system") i++
  const systemHead = conversation.slice(0, i)
  let j = i
  while (j < conversation.length && isSummaryMessage(conversation[j])) j++
  const frozen = conversation.slice(i, j)
  const head = conversation.slice(0, j)
  const rest = conversation.slice(j)
  const keep = Math.max(0, keepRecentMessages)
  if (rest.length <= keep) return null
  const middle = rest.slice(0, rest.length - keep)
  const tail = rest.slice(rest.length - keep)
  if (middle.length === 0) return null
  return { head, systemHead, frozen, middle, tail }
}

/**
 * REUSE mode: keep prior `frozen` summaries byte-identical and append ONE new
 * versioned summary of the genuinely-new `middle`. This is what gives prefix-
 * cache stability — the leading `[system…, frozen…]` block never changes.
 */
export function applyCompactionIncremental({
  conversation,
  keepRecentMessages,
  summary,
  nextVersion,
}) {
  const plan = planCompaction({ conversation, keepRecentMessages })
  if (!plan) return conversation
  return [
    ...plan.systemHead,
    ...plan.frozen,
    makeSummaryMessage(summary, nextVersion),
    ...plan.tail,
  ]
}

/**
 * REGENERATE mode: collapse all prior frozen summaries + the new summary into a
 * single fresh summary message. Accepts a one-time prefix-cache break to bound
 * growth once too many frozen summaries have accumulated.
 */
export function applyCompactionRegenerated({ conversation, keepRecentMessages, summary, version }) {
  const plan = planCompaction({ conversation, keepRecentMessages })
  if (!plan) return conversation
  return [...plan.systemHead, makeSummaryMessage(summary, version), ...plan.tail]
}

/**
 * Back-compat wrapper: a single incremental compaction at version 1. Retained
 * for callers/tests that just want "head + summary + tail".
 */
export function applyCompaction({ conversation, keepRecentMessages, summary }) {
  return applyCompactionIncremental({ conversation, keepRecentMessages, summary, nextVersion: 1 })
}
