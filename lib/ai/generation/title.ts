/**
 * Conversation-title generation from the first turn.
 *
 * Mirrors the pattern every coding agent ships (Claude Code / OpenCode /
 * Codex / ChatGPT): after the first user + assistant exchange, ask a cheap
 * model for a short topic title. The instant first-message truncation in the
 * chat hook stays as a placeholder; this upgrades it once the turn lands.
 *
 * The client comes from `buildUtilityLlmClient`. This module only owns the
 * prompt + output sanitisation so it stays pure and unit-testable with a
 * mock client.
 */

import type { LlmClient } from "@/lib/twin/distill/llm"

export interface GenerateTitleArgs {
  firstUserText: string
  firstAssistantText?: string
  /** UI locale so the title language matches the user (e.g. "zh-CN"). */
  locale?: string
  /**
   * What is being titled. `"chat"` (default) frames it as a conversation and
   * labels the inputs User / Assistant reply. `"work"` frames it as a task /
   * unit of work (agent-team run, workflow run) and labels the inputs
   * Task / Result — the same cheap-model contract, only the framing differs.
   */
  kind?: "chat" | "work"
}

/** Hard ceiling on the returned title length (characters). */
export const MAX_TITLE_LENGTH = 48

const SYSTEM_PROMPT_CHAT =
  "You generate a very short title for a chat conversation. Rules: " +
  "summarise the topic in at most 8 words; no surrounding quotes; no trailing " +
  "punctuation; no prefixes like 'Title:'; a single line; write it in the same " +
  "language as the user's message."

const SYSTEM_PROMPT_WORK =
  "You generate a very short title for a unit of work (an automated task or " +
  "workflow run). Rules: summarise what the work is about in at most 8 words; " +
  "no surrounding quotes; no trailing punctuation; no prefixes like 'Title:'; " +
  "a single line; write it in the same language as the task description."

/**
 * Clean a raw model response into a usable title: take the first line, strip
 * wrapping quotes / markdown / a leading "Title:" label, collapse whitespace,
 * and clamp to {@link MAX_TITLE_LENGTH}. Returns "" when nothing usable
 * remains (caller keeps the placeholder).
 */
export function sanitizeTitle(raw: string): string {
  let s = (raw ?? "").trim()
  if (!s) return ""
  // First non-empty line only.
  s =
    s
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ""
  // Drop a leading "Title:" / "标题：" style label.
  s = s.replace(/^\s*(title|标题)\s*[:：]\s*/i, "")
  // Strip surrounding matching quotes (straight or smart) and backticks.
  s = s.replace(/^["'`“”『「]+/, "").replace(/["'`“”』」]+$/, "")
  // Strip surrounding markdown emphasis.
  s = s.replace(/^[*_#>\s]+/, "").replace(/[*_\s]+$/, "")
  // Collapse internal whitespace.
  s = s.replace(/\s+/g, " ").trim()
  // Drop a single trailing sentence-ending punctuation.
  s = s.replace(/[.。!！?？,，;；]+$/, "").trim()
  if (s.length > MAX_TITLE_LENGTH) s = s.slice(0, MAX_TITLE_LENGTH).trim()
  return s
}

/**
 * Generate a conversation title. Returns "" on any failure or empty output
 * so the caller silently keeps the existing placeholder title.
 */
export async function generateConversationTitle(
  client: LlmClient,
  { firstUserText, firstAssistantText, locale, kind = "chat" }: GenerateTitleArgs
): Promise<string> {
  const user = (firstUserText ?? "").trim()
  if (!user) return ""

  const work = kind === "work"
  const localeHint = locale ? `\nUI locale: ${locale}` : ""
  const intro = work ? "Work so far:" : "Conversation so far:"
  const sourceLabel = work ? "Task" : "User"
  const resultLabel = work ? "Result" : "Assistant reply"
  const result = firstAssistantText?.trim()
    ? `\n\n${resultLabel}:\n${firstAssistantText.trim().slice(0, 1000)}`
    : ""
  const prompt =
    `${intro}${localeHint}\n\n${sourceLabel}:\n${user.slice(0, 2000)}${result}\n\n` + "Title:"

  try {
    const text = await client.complete(prompt, {
      system: work ? SYSTEM_PROMPT_WORK : SYSTEM_PROMPT_CHAT,
      temperature: 0.3,
      maxTokens: 32,
    })
    return sanitizeTitle(text)
  } catch {
    return ""
  }
}
