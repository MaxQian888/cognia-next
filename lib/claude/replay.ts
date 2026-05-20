// ADR-0028 Phase 6 — Dexie-sourced replay for stale SDK sessions.
//
// SDK bug #16103 means `--resume` does not honour `CLAUDE_CONFIG_DIR` —
// when we set a per-account configdir, the spawned CLI subprocess looks
// for the session file under the DEFAULT `~/.claude/projects/`, fails to
// find it, and the resume errors out.
//
// Workaround: when the sidecar has restarted and the session's stored
// `sdkSessionId` is stale, skip the SDK resume and instead prepend a
// Dexie-sourced replay block to the first user turn. The SDK starts a
// fresh conversation but the model gets the context.
//
// V1 keeps the strategy dumb: last N user/assistant turns, trimmed to a
// token budget. Smarter compression (per-message summarization, tool-
// result elision) is a follow-up — the V1 cost is only paid once per
// sidecar restart per session, not per send.

import type { StoredMessage } from "@/lib/claude/types"

export interface BuildReplayPromptOptions {
  /** Drop the oldest turns when the total exceeds this many characters. */
  maxChars: number
  /** Cap on how many `(user, assistant)` pairs to include. */
  maxTurns: number
}

export const DEFAULT_REPLAY_OPTIONS: BuildReplayPromptOptions = {
  maxChars: 12_000,
  maxTurns: 20,
}

/** Extract a plain-text representation of a Dexie message's parts. */
export function flattenMessageText(message: StoredMessage): string {
  const parts = message.parts ?? []
  const chunks: string[] = []
  for (const part of parts as Array<{ type?: string; text?: string }>) {
    if (part && typeof part === "object" && typeof part.text === "string") {
      chunks.push(part.text)
    }
  }
  return chunks.join("").trim()
}

/**
 * Build the replay prompt prefix from prior Dexie messages plus the
 * current user message. Returns the empty string when there's no prior
 * context to replay — callers can then send the raw current message
 * unchanged.
 *
 * Output shape (one block per turn):
 *
 *   ## Prior conversation (replayed after sidecar restart — see ADR-0028 §"Resume bug")
 *
 *   USER: ...
 *   ASSISTANT: ...
 *   USER: ...
 *   ASSISTANT: ...
 *
 *   ## Current message
 *
 *   <currentMessage>
 *
 * Truncation strategy: keep the LATEST turns; drop oldest first when the
 * char budget or turn count is exceeded.
 */
export function buildReplayPrompt(
  messages: ReadonlyArray<StoredMessage>,
  currentMessage: string,
  options: Partial<BuildReplayPromptOptions> = {}
): string {
  const opts: BuildReplayPromptOptions = { ...DEFAULT_REPLAY_OPTIONS, ...options }

  // Skip system messages and the in-flight user turn (current message is
  // appended at the end). We replay user + assistant only.
  const eligible = messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && (m.parts?.length ?? 0) > 0
  )

  if (eligible.length === 0) {
    return currentMessage.trim()
  }

  // Pair user / assistant turns. We don't enforce strict alternation —
  // dangling user messages are valid (e.g., the model errored mid-stream
  // last session) and dangling assistant messages also possible. Just
  // take the latest turns up to `maxTurns` regardless of role.
  const truncated = eligible.slice(-opts.maxTurns)

  const lines: string[] = []
  lines.push('## Prior conversation (replayed after sidecar restart — see ADR-0028 §"Resume bug")')
  lines.push("")
  let totalChars = lines.join("\n").length
  let dropped = 0
  for (const m of truncated) {
    const text = flattenMessageText(m)
    if (!text) continue
    const role = m.role === "user" ? "USER" : "ASSISTANT"
    const block = `${role}: ${text}`
    // Stop including more turns when we'd blow the budget. We keep the
    // newer turns (this is a forward iteration over the post-slice tail,
    // so "stop" means "drop older — already excluded by the slice").
    if (totalChars + block.length + 1 > opts.maxChars) {
      dropped += truncated.length - lines.length
      break
    }
    lines.push(block)
    totalChars += block.length + 1
  }

  if (dropped > 0) {
    lines.push("")
    lines.push(`(${dropped} earlier turn(s) elided to fit the token budget.)`)
  }

  lines.push("")
  lines.push("## Current message")
  lines.push("")
  lines.push(currentMessage.trim())

  return lines.join("\n")
}
