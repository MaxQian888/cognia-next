/**
 * Conversation projection and the canonical summary prompt.
 *
 * The model call itself lives in `summarize-material.ts` (chunked, PII-gated,
 * typed outcomes). This module owns the shared prompt text and the pure text
 * projections both it and the branch dialog read: the role-labelled transcript
 * segments, and the deterministic head/tail digest shown when no model summary
 * is available.
 */

import type { UIMessage } from "ai"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import { definePrompt } from "@/lib/prompts/types"

const ROLE_LABEL: Record<string, string> = {
  user: "User",
  assistant: "Assistant",
  system: "System",
}

/**
 * Canonical conversation-summary system prompt. Single source of truth shared
 * by summarize-then-branch (`summarize-material.ts`) and context-window compaction
 * (`lib/claude/compact-instructions.ts` composes its summary prompt from this
 * + the active strategy + the user focus). Do not fork the wording; customize
 * it through the Prompt Center, which both consumers resolve.
 */
export const CONVERSATION_SUMMARY_PROMPT = definePrompt({
  id: "generation.summary.conversation",
  contractVersion: 1,
  kind: "feature-template",
  group: "generation",
  operation: "replace-template",
  scopes: ["account", "workspace", "agent"],
  activation: "next-operation",
  // Compaction keeps working from this summary, so a careless edit loses the
  // goals and constraints a long session depends on.
  risk: "protocol",
  hosts: ["app", "cli"],
  defaultBody:
    "You summarize a chat conversation so it can seed a new branch of the same " +
    "discussion. Write a concise, neutral summary that preserves: the user's " +
    "goal, key facts and decisions, any constraints, and open / unresolved " +
    "threads. Use short paragraphs or bullet points. Do not add a preamble like " +
    "'Here is a summary'. Write in the same language as the conversation.",
  outputContract: "Free-text summary; it becomes the authoritative record after compaction.",
  maxChars: 8_000,
  consumers: ["lib/ai/generation/summarize-material.ts", "lib/claude/build-options.ts"],
})

/**
 * Render a conversation slice as a plain-text transcript. Empty turns
 * (tool-only assistant steps) are skipped. Exported for tests.
 */
export function renderConversation(messages: UIMessage[]): string {
  return renderConversationSegments(messages).join("\n\n")
}

/**
 * The same transcript, one role-labelled entry per message — the unit
 * `summarizeMaterial` packs chunks on, so a long conversation is split between
 * messages rather than through one.
 */
export function renderConversationSegments(messages: readonly UIMessage[]): string[] {
  const lines: string[] = []
  for (const m of messages) {
    const text = extractPlainText(m.parts)
    if (!text) continue
    lines.push(`${ROLE_LABEL[m.role] ?? m.role}: ${text}`)
  }
  return lines
}

/**
 * Deterministic, model-free digest: head + tail of the conversation with an
 * elision marker. Always returns usable text; the branch dialog shows it when a
 * model summary is unavailable.
 */
export function structuralSummary(messages: UIMessage[]): string {
  if (messages.length === 0) return ""
  const line = (m: UIMessage) => {
    const text = extractPlainText(m.parts).slice(0, 120)
    return `${ROLE_LABEL[m.role] ?? m.role}: ${text || `[${m.role}]`}`
  }
  if (messages.length <= 6) {
    return [`[Conversation: ${messages.length} messages]`, ...messages.map(line)].join("\n")
  }
  const head = messages.slice(0, 3)
  const tail = messages.slice(-3)
  return [
    `[Conversation: ${messages.length} messages]`,
    "Beginning:",
    ...head.map(line),
    `…(${messages.length - 6} messages elided)…`,
    "Recent:",
    ...tail.map(line),
  ].join("\n")
}
