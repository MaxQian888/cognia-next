/**
 * The unsent draft (ADR-0228 §8).
 *
 * Closing the panel used to throw away a capture and a half-written
 * instruction. The draft keeps them in `chrome.storage.session` — memory only,
 * cleared when the browser exits, never written to the profile — so reopening
 * the panel picks up where the person left off. Attachments are not kept: they
 * run to megabytes, the session area is small, and a screenshot is a moment
 * that re-taking represents better than restoring. The draft says how many
 * there were, so the panel can say so.
 */
import type { CapturedPage, CaptureScope } from "../panel-state"

export interface PanelDraft {
  v: 1
  captured: CapturedPage | null
  /** Other tabs added to the submission (ADR-0228 §2). */
  extraPages: CapturedPage[]
  scope: CaptureScope
  instruction: string
  workspaceId: string | null
  targetId: string | null
  targetParams: Record<string, string>
  includeFullUrl: boolean
  /** Attachments on screen when saved, which the draft does not carry. */
  droppedAttachments: number
  savedAt: number
}

/** A draft older than this is a different afternoon's work; it is not restored. */
export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isText(value: unknown): value is { text: string; truncated: boolean } {
  return isRecord(value) && typeof value.text === "string" && typeof value.truncated === "boolean"
}

/** Whether a stored value is a page this build can show; anything else is dropped. */
export function isCapturedPage(value: unknown): value is CapturedPage {
  if (!isRecord(value)) return false
  return (
    typeof value.tabId === "number" &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    typeof value.rawUrl === "string" &&
    typeof value.capturedAt === "number" &&
    typeof value.strippedQuery === "boolean" &&
    (value.selection === null || isText(value.selection)) &&
    (value.readableText === null || isText(value.readableText)) &&
    (value.article === undefined || value.article === null || isText(value.article))
  )
}

export function parseDraft(value: unknown, now: number): PanelDraft | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.savedAt !== "number") return null
  if (now - value.savedAt > DRAFT_TTL_MS || value.savedAt > now + 60_000) return null
  const captured =
    value.captured === null ? null : isCapturedPage(value.captured) ? value.captured : undefined
  if (captured === undefined) return null
  const scope: CaptureScope =
    value.scope === "page" || value.scope === "article" ? value.scope : "auto"
  const targetParams = isRecord(value.targetParams)
    ? Object.fromEntries(
        Object.entries(value.targetParams).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      )
    : {}
  return {
    v: 1,
    captured,
    extraPages: Array.isArray(value.extraPages) ? value.extraPages.filter(isCapturedPage) : [],
    scope,
    instruction: typeof value.instruction === "string" ? value.instruction : "",
    workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : null,
    targetId: typeof value.targetId === "string" ? value.targetId : null,
    targetParams,
    includeFullUrl: value.includeFullUrl === true,
    droppedAttachments:
      typeof value.droppedAttachments === "number" && value.droppedAttachments > 0
        ? Math.floor(value.droppedAttachments)
        : 0,
    savedAt: value.savedAt,
  }
}

/** Nothing worth keeping: no capture, no other page, no words. */
export function isEmptyDraft(
  draft: Pick<PanelDraft, "captured" | "extraPages" | "instruction">
): boolean {
  return draft.captured === null && draft.extraPages.length === 0 && draft.instruction.trim() === ""
}
