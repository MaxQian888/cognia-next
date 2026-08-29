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

/** Longest first line used as the draft's title before it is elided. */
const TITLE_MAX = 80

/**
 * Name the draft after its opening line.
 *
 * Shares the shape of `asideTitleFor` in `message-selection-toolbar.tsx` — a
 * word-boundary elision — because both name a record after a fragment of prose
 * and a mid-word cut reads as corruption in both.
 */
export function memoryDraftTitle(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim()
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
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

  const { submitAgentMemoryFinding } = await import("@/lib/memory/agent-findings")
  const title = memoryDraftTitle(body)
  await submitAgentMemoryFinding({
    authorId: authorId || "assistant",
    // `subagent` and not `external_agent`: the trust label decides whether the
    // draft is filed as private or untrusted, and a reply from this app's own
    // assistant is not third-party text. A turn that quoted the web is still
    // covered — the distiller's gate runs on the body either way.
    authorKind: "subagent",
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
