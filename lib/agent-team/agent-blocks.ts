/**
 * `<info_for_agent>` hidden agent blocks — ported from an external agent-orchestration
 * app's controller (`internal/agentBlocks.js`).
 *
 * Teammates sometimes need to pass operational instructions to ANOTHER teammate that the
 * human operator should not see in the workspace chat (e.g. "before you start, re-read the
 * cache module"). Those go inside an `<info_for_agent>…</info_for_agent>` block. The full
 * content stays in the store (so the recipient teammate's next-turn context still has it),
 * but the human-facing UI strips the block before rendering. Blocks must NEVER appear in
 * messages addressed to the user — the team messaging protocol tells teammates as much.
 *
 * Pure string utilities, no I/O.
 */

export const AGENT_BLOCK_TAG = "info_for_agent"
export const AGENT_BLOCK_OPEN = `<${AGENT_BLOCK_TAG}>`
export const AGENT_BLOCK_CLOSE = `</${AGENT_BLOCK_TAG}>`

/** Matches a full `<info_for_agent>…</info_for_agent>` block (non-greedy, multiline). */
const AGENT_BLOCK_RE = new RegExp(`<${AGENT_BLOCK_TAG}>[\\s\\S]*?</${AGENT_BLOCK_TAG}>`, "g")

/** Wrap hidden agent-only instructions. Returns "" for empty input (nothing to hide). */
export function wrapAgentBlock(text: string): string {
  const trimmed = typeof text === "string" ? text.trim() : ""
  if (!trimmed) return ""
  return `${AGENT_BLOCK_OPEN}\n${trimmed}\n${AGENT_BLOCK_CLOSE}`
}

/** True when `text` contains at least one agent-only block. */
export function hasAgentBlock(text: string): boolean {
  if (typeof text !== "string") return false
  AGENT_BLOCK_RE.lastIndex = 0
  return AGENT_BLOCK_RE.test(text)
}

/**
 * Strip every `<info_for_agent>…</info_for_agent>` block from `text` and trim. Used by the
 * workspace UI so hidden coordination chatter never reaches the human operator.
 */
export function stripAgentBlocks(text: string): string {
  if (typeof text !== "string") return ""
  return text
    .replace(AGENT_BLOCK_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}
