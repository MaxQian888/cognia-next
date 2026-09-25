/**
 * What the copilot knows about the conversation beyond the transcript
 * (ADR-0194) — Jarvis's `ContextBuilder`, mapped onto Cognia's data:
 *
 * - **Always on**: the contact's user-authored relationship and note
 *   (`platformIdentities`, edited in the contact drawer). Never trimmed.
 * - **Droppable**: long-term memory recalled against the latest turns, only
 *   when memory recall is allowed for the session AND the user opted the
 *   copilot into it (off by default, like Jarvis's `contextEnabled`). Lines
 *   are dropped from the least relevant end to stay inside the budget.
 *
 * The recall query is redacted before it reaches the embedder (possibly a
 * cloud call) and refused if anything survives redaction; recalled lines are
 * PII-filtered by `recallAboutUser`.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import { contactProfileOf } from "@/lib/db/platform-identities"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import type { CopilotTranscript } from "@/lib/reply-copilot/build-state"

/** Background + relationship budget (Jarvis `ContextBuilder.BUDGET_CHARS`). */
export const KNOWLEDGE_BUDGET_CHARS = 1500

/** Only the latest turns feed the recall query (Jarvis `MATCH_WINDOW`). */
export const RECALL_WINDOW = 6

export interface CopilotKnowledge {
  /** Relationship label for `chat.relationship`; empty when unknown. */
  relationship: string
  /** `background` text for the judge + drafts; empty when there is none. */
  background: string
  contactId: string | null
  contactName: string | null
  hasNote: boolean
  memoryLines: number
  /** Why memory was not consulted, when it was not. */
  memorySkipped: "disabled" | "pii" | "empty" | null
}

export interface KnowledgeInput {
  transcript: CopilotTranscript
  contact: PlatformIdentityRow | null
  /** Session memory policy allows recall AND the copilot memory opt-in is on. */
  memoryAllowed: boolean
}

export interface KnowledgeDeps {
  /** Recalled memory texts, most relevant first. */
  recall: (query: string) => Promise<string[]>
}

function recallQuery(transcript: CopilotTranscript): string {
  return transcript.turns
    .slice(-RECALL_WINDOW)
    .map((turn) => turn.text)
    .join("\n")
    .trim()
}

export async function gatherKnowledge(
  input: KnowledgeInput,
  deps: KnowledgeDeps
): Promise<CopilotKnowledge> {
  const profile = input.contact ? contactProfileOf(input.contact) : {}
  const relationship = profile.relationship?.trim() ?? ""
  const note = profile.note?.trim() ?? ""
  const base: Omit<CopilotKnowledge, "background" | "memoryLines" | "memorySkipped"> = {
    relationship,
    contactId: input.contact?.id ?? null,
    contactName: input.contact?.displayName ?? null,
    hasNote: Boolean(note),
  }

  const alwaysOn = note ? `About this contact: ${note}` : ""
  let memorySkipped: CopilotKnowledge["memorySkipped"] = null
  const memory: string[] = []
  if (!input.memoryAllowed) {
    memorySkipped = "disabled"
  } else {
    const query = redactText(recallQuery(input.transcript)).redacted
    if (!query) memorySkipped = "empty"
    else if (!hasNoLeakingPii(query)) memorySkipped = "pii"
    else {
      const recalled = await deps.recall(query).catch(() => [])
      let used = relationship.length + alwaysOn.length
      for (const line of recalled) {
        const text = line.trim()
        if (!text || !hasNoLeakingPii(text)) continue
        const cost = text.length + 3
        if (used + cost > KNOWLEDGE_BUDGET_CHARS) break
        memory.push(text)
        used += cost
      }
      if (!memory.length) memorySkipped = "empty"
    }
  }

  const sections = [
    alwaysOn,
    memory.length ? `What you remember:\n${memory.map((m) => `- ${m}`).join("\n")}` : "",
  ].filter(Boolean)
  return {
    ...base,
    background: sections.join("\n\n"),
    memoryLines: memory.length,
    memorySkipped,
  }
}
