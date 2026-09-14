/**
 * Keep what an assistant turn worked out, as a pending memory draft.
 *
 * `lib/memory/agent-findings.ts` was built for exactly this and had zero
 * callers anywhere in the repo: a finished pipeline that runs an agent's output
 * through `distillInbound` under `DENY_MODEL_GATE`, files it as a PRIVATE
 * PENDING draft, and leaves promotion to the existing inbound acceptance flow.
 * Every part of that was written and none of it was reachable.
 *
 * This is the other half of reuse. `@result:` and `@msg:` carry a result
 * forward into the next turn; this carries it forward past the conversation
 * entirely — into the memory the assistant recalls on its own.
 *
 * Deliberately a DRAFT and not a memory. The gate is the point: agent-derived
 * knowledge is never asserted straight into recall, because a turn that read a
 * web page and summarised it would otherwise write that page's claims into
 * something the model later treats as the user's own.
 */

import { projectSearchText } from "@/lib/chat/search/project-text"
import { selectionTitleFor } from "@/lib/chat/selection/selection-text"
import {
  resolveMessageSpeaker,
  speakerTranscriptName,
  type SpeakerSource,
} from "@/lib/chat/speaker"

/** Longest first line used as the draft's title before it is elided. */
const TITLE_MAX = 80

/**
 * Name the draft after its opening line.
 *
 * The same word-boundary elision a transcript selection is named with
 * (`selectionTitleFor`), because both name a record after a fragment of prose
 * and a mid-word cut reads as corruption in both.
 */
export function memoryDraftTitle(body: string): string {
  return selectionTitleFor(body, TITLE_MAX)
}

export interface SaveMessageAsMemoryInput {
  /** The message's parts, projected here rather than by the caller. */
  parts: unknown
  sessionId: string
  projectId?: string | null
  /** Who produced the turn — a subagent handle, a teammate id, or the model. */
  authorId?: string
}

/**
 * Returns the draft's title on success, or null when the turn had nothing to
 * keep. Throws only when the distiller REJECTS it — a PII gate refusal is a
 * real answer the caller must show, not something to swallow.
 */
export async function saveMessageAsMemory({
  parts,
  sessionId,
  projectId,
  authorId,
}: SaveMessageAsMemoryInput): Promise<string | null> {
  // The search projection, not `projectMessageBody`: a memory draft should be
  // the turn's PROSE. Folding in tool outputs would file a file listing as
  // something to remember about the user.
  const body = projectSearchText(parts).trim()
  if (!body) return null
  return fileDraft({ title: memoryDraftTitle(body), body, sessionId, projectId, authorId })
}

export interface SaveMessagesAsMemoryInput {
  /**
   * The messages, in transcript order. The authorship fields matter: a `user`
   * row can be someone else's (an IM group, a shared session).
   */
  messages: readonly { role: string; parts: unknown; metadata?: unknown }[]
  sessionId: string
  projectId?: string | null
}

/**
 * Several ticked messages as ONE pending draft, each passage under who said it.
 *
 * One draft and not one per message: what a person ticks together is one thing
 * worth remembering — a question and the answer that settled it — and split
 * apart, the answer would be filed without the question that gives it meaning.
 * The user's own turns are included here, unlike the single-message action,
 * because in a conversation the question is half of what was worked out; the
 * role label keeps the two from reading as one voice. The same distiller and
 * gate take it, so a refusal still throws.
 *
 * Who said a passage is resolved, not read off the role. In an IM group or a
 * shared session a `user` row is another person, so it is labelled with their
 * prompt-safe name (`lib/chat/speaker.ts`) and the whole draft is filed as
 * untrusted: someone else's words must not enter recall as the user's own.
 */
export async function saveMessagesAsMemory({
  messages,
  sessionId,
  projectId,
}: SaveMessagesAsMemoryInput): Promise<string | null> {
  let thirdParty = false
  const passages = messages.flatMap((message) => {
    const text = projectSearchText(message.parts).trim()
    if (!text) return []
    // Structural, as the transcript renders it: a `UIMessage` types its metadata
    // loosely, and the resolver reads only the authorship fields it knows.
    const speaker = resolveMessageSpeaker(message as SpeakerSource)
    // A named agent is this app's own teammate; anyone else is not the user.
    if (speaker && speaker.kind !== "agent") thirdParty = true
    return [{ label: speaker ? speakerTranscriptName(speaker) : message.role, text }]
  })
  if (passages.length === 0) return null
  // The raw role where nobody else is named, like the transcript projections a
  // model reads elsewhere: the draft is recalled into prompts, so it is not
  // localized.
  const body = passages.map(({ label, text }) => `${label}: ${text}`).join("\n\n")
  return fileDraft({
    // Named after the first passage's words, not its label.
    title: memoryDraftTitle(passages[0]!.text),
    body,
    sessionId,
    projectId,
    ...(thirdParty ? { authorKind: "external_agent" as const } : {}),
  })
}

async function fileDraft({
  title,
  body,
  sessionId,
  projectId,
  authorId,
  authorKind = "subagent",
}: {
  title: string
  body: string
  sessionId: string
  projectId?: string | null
  authorId?: string
  /** Decides the draft's trust label: `external_agent` files it as untrusted. */
  authorKind?: "subagent" | "external_agent"
}): Promise<string> {
  const { submitAgentMemoryFinding } = await import("@/lib/memory/agent-findings")
  await submitAgentMemoryFinding({
    authorId: authorId || "assistant",
    // `subagent` unless someone else's words are in it: the trust label decides
    // whether the draft is filed as private or untrusted, and a reply from this
    // app's own assistant is not third-party text. A turn that quoted the web is
    // still covered — the distiller's gate runs on the body either way.
    authorKind,
    title,
    body,
    // "Something that is true", not a procedure: a captured reply is a
    // statement, and `skill` would file it as steps to follow.
    kind: "fact",
    sessionId,
    ...(projectId ? { projectId } : {}),
  })
  return title
}
