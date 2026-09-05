/**
 * File an assistant reply as a tracker issue (spec 2026-09-06 D9).
 *
 * The other half of `save-message-as-memory.ts`: a memory draft keeps what a
 * turn worked out, an issue keeps what a turn found that still has to be
 * done. The reply's first line names the issue and the rest is its
 * description, the session and message are recorded as the issue's origin
 * (so the board can jump back to the conversation), and the write goes
 * through `lib/issues/service.ts` like every other programmatic create.
 */

import { projectSearchText } from "@/lib/chat/search/project-text"
import type { Issue } from "@/types/issues"

/** Longest title before the first line is elided at a word boundary. */
const TITLE_MAX = 120

export function issueTitleFromBody(body: string): string {
  const firstLine =
    body
      .split(/\r?\n/)
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? ""
  const flat = firstLine.replace(/\s+/g, " ").trim()
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

export interface SaveMessageAsIssueInput {
  /** The message's parts, projected here rather than by the caller. */
  parts: unknown
  sessionId: string
  messageId: string
  /** Workspace. Defaults to the active one inside the service. */
  projectId?: string | null
}

/**
 * Returns the created issue, or null when the reply had nothing readable.
 * Throws when the tracker refuses (no project yet, no workspace): a real
 * answer the caller must show.
 */
export async function saveMessageAsIssue({
  parts,
  sessionId,
  messageId,
  projectId,
}: SaveMessageAsIssueInput): Promise<Issue | null> {
  // The search projection: the issue should carry the turn's own TEXT, not a
  // tool's file listing.
  const body = projectSearchText(parts).trim()
  if (!body) return null
  const title = issueTitleFromBody(body)
  if (!title) return null
  const { createIssueRecord } = await import("@/lib/issues/service")
  return createIssueRecord({
    title,
    description: body,
    by: { kind: "human" },
    ...(projectId ? { projectId } : {}),
    origin: { kind: "chat", sessionId, messageId },
  })
}
