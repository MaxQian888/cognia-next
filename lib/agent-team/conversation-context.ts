/**
 * Convert the team workspace's `AgentTeamMessage[]` log into context that
 * runtimes can consume on follow-up turns. Two output shapes:
 *
 *   - `historyAsClaudeMessages` → Vercel AI SDK `messages` array. User turns
 *     stay verbatim; assistant turns get a `[<speaker>]:` prefix so Claude
 *     can disambiguate when multiple agents share the conversation.
 *
 *   - `historyAsTextPreamble` → flat text block prepended to the prompt for
 *     ACP-style runtimes (Codex CLI, Claude Code CLI, Gemini, Cursor) that
 *     don't expose a structured `messages` parameter.
 *
 * `buildConversationHistory` filters out streaming placeholders, errored
 * cards, and non-conversational types (plan approvals, task updates) so we
 * don't poison the next turn with bookkeeping noise.
 */

import type { AgentTeamMessage } from "@/types/agent/agent-team"
import { TEAM_USER_SENDER_ID } from "@/types/agent/agent-team"
import { TEAM_MESSAGE_METADATA_KEYS } from "./team-runtime-dispatcher"

export interface ConversationTurn {
  role: "user" | "assistant"
  speakerName: string
  content: string
  timestamp: Date
}

export interface BuildHistoryOptions {
  /** Drop messages whose id is in this list (e.g., the user message we're about to dispatch). */
  excludeMessageIds?: readonly string[]
  /** Cap to the most recent N turns. Defaults to 20. */
  maxTurns?: number
}

const DEFAULT_MAX_TURNS = 20

const CONVERSATIONAL_TYPES = new Set<AgentTeamMessage["type"]>(["direct", "broadcast"])

export function buildConversationHistory(
  messages: readonly AgentTeamMessage[],
  options: BuildHistoryOptions = {}
): ConversationTurn[] {
  const { excludeMessageIds, maxTurns = DEFAULT_MAX_TURNS } = options
  const excluded = excludeMessageIds ? new Set(excludeMessageIds) : null

  const sorted = [...messages].sort((a, b) => {
    const ta = a.timestamp instanceof Date ? a.timestamp.getTime() : 0
    const tb = b.timestamp instanceof Date ? b.timestamp.getTime() : 0
    return ta - tb
  })

  const turns: ConversationTurn[] = []
  for (const m of sorted) {
    if (excluded?.has(m.id)) continue
    if (!CONVERSATIONAL_TYPES.has(m.type)) continue
    if (m.structuredPayload) continue
    if (!m.content || !m.content.trim()) continue
    if (m.metadata?.[TEAM_MESSAGE_METADATA_KEYS.STREAMING] === true) continue
    if (m.metadata?.[TEAM_MESSAGE_METADATA_KEYS.ERROR] === true) continue

    turns.push({
      role: m.senderId === TEAM_USER_SENDER_ID ? "user" : "assistant",
      speakerName: m.senderName,
      content: m.content,
      timestamp: m.timestamp instanceof Date ? m.timestamp : new Date(),
    })
  }

  if (turns.length <= maxTurns) return turns
  return turns.slice(turns.length - maxTurns)
}

export function historyAsClaudeMessages(
  turns: readonly ConversationTurn[]
): Array<{ role: "user" | "assistant"; content: string }> {
  const out: Array<{ role: "user" | "assistant"; content: string }> = []
  for (const turn of turns) {
    const piece =
      turn.role === "assistant" ? `[${turn.speakerName}]: ${turn.content}` : turn.content
    const last = out[out.length - 1]
    if (last && last.role === turn.role) {
      last.content = `${last.content}\n\n${piece}`
    } else {
      out.push({ role: turn.role, content: piece })
    }
  }
  return out
}

export function historyAsTextPreamble(turns: readonly ConversationTurn[]): string {
  if (turns.length === 0) return ""
  const lines = turns.map((t) => {
    const speaker = t.role === "user" ? "You" : t.speakerName
    return `${speaker}: ${t.content}`
  })
  return ["[Conversation so far]", ...lines, ""].join("\n")
}
