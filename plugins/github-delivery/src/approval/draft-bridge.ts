/**
 * HITL approval bridge — when a GitHub action's policy gate returns
 * `needsApproval: true`, the executor pauses by creating a `connectorDrafts`
 * row scoped to the workflow step. The Inbox renders that draft through the
 * shared `<DraftEditor/>` UI (the same surface platform connectors use for
 * the manual/draft reply flow), letting the user inspect the proposed
 * action, optionally edit the comment body, and click Approve or Reject.
 * The bridge polls the draft's status and resolves once it transitions
 * away from `pending` — so the workflow step resumes without needing any
 * new Dexie tables or UI components.
 *
 * The conversationKey embeds (runId, stepId) so re-entering the step after
 * a process restart finds the existing pending draft instead of opening a
 * duplicate.
 */

import { createDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import { getDb } from "@/lib/db/schema"
import type { MessageSegment } from "@/types/connectors/segment"

export interface HitlApprovalRequest {
  runId: string
  stepId: string
  repoFullName: string
  /** Short human-readable description of what would happen ("Merge PR #42 in foo/bar"). */
  actionSummary: string
  /**
   * For comment-style actions, the proposed body the user can edit. Omit
   * for non-textual actions (merge, label, close) — the user can still
   * approve/reject but cannot edit a body.
   */
  proposedBody?: string
  /** Inherits from the surrounding workflow step's signal. */
  signal: AbortSignal
  /**
   * Optional polling interval (ms). Exposed for tests. Production defaults
   * to 1 s — the Inbox UI flips status synchronously on click, so the
   * resume latency is bounded by this interval.
   */
  pollIntervalMs?: number
}

export interface HitlApprovalResult {
  outcome: "approve" | "reject"
  /** Free-text reason / feedback from the user (or system on expiry). */
  feedback?: string
  /**
   * For comment-style actions: the (possibly edited) body the user
   * approved. Omitted on reject or when no proposedBody was supplied.
   */
  editedBody?: string
  /** The draft row id, exposed for audit / debugging. */
  draftId: string
}

const DEFAULT_POLL_MS = 1000
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60_000 // 7 days

export function conversationKeyForApproval(runId: string, stepId: string): string {
  return `gh:approval:${runId}:${stepId}`
}

/**
 * Build (or reuse) a pending draft and block until the user approves or
 * rejects it. Resolves with the user's decision + (for comment actions)
 * their edited body.
 */
export async function requestHitlApproval(req: HitlApprovalRequest): Promise<HitlApprovalResult> {
  const conversationKey = conversationKeyForApproval(req.runId, req.stepId)
  const draft = await ensureDraft(conversationKey, req)
  const pollMs = req.pollIntervalMs ?? DEFAULT_POLL_MS

  while (true) {
    if (req.signal.aborted) {
      throw new Error("HITL approval cancelled (workflow step aborted)")
    }
    const current = await getDb().connectorDrafts.get(draft.id)
    if (!current) {
      return {
        outcome: "reject",
        feedback: "draft was deleted before a decision was recorded",
        draftId: draft.id,
      }
    }
    if (current.status === "approved") {
      return {
        outcome: "approve",
        editedBody: extractText(current.segments),
        draftId: draft.id,
      }
    }
    if (current.status === "rejected") {
      return {
        outcome: "reject",
        editedBody: req.proposedBody ? extractText(current.segments) : undefined,
        draftId: draft.id,
      }
    }
    if (current.status === "expired") {
      return {
        outcome: "reject",
        feedback: "draft expired without a decision",
        draftId: draft.id,
      }
    }
    await delay(pollMs)
  }
}

async function ensureDraft(
  conversationKey: string,
  req: HitlApprovalRequest
): Promise<ConnectorDraftRow> {
  // Reuse the existing pending draft for the same (runId, stepId) so a
  // process restart that re-enters the step doesn't create duplicates.
  const existing = await getDb()
    .connectorDrafts.where("[conversationKey+createdAt]")
    .between([conversationKey, -Infinity], [conversationKey, Infinity])
    .filter((r) => r.status === "pending")
    .toArray()
  if (existing.length > 0) {
    // Most recent wins.
    existing.sort((a, b) => b.createdAt - a.createdAt)
    return existing[0]
  }
  const segments: MessageSegment[] = req.proposedBody
    ? [
        { type: "text", text: `[cognia GitHub Delivery] ${req.actionSummary}` },
        { type: "text", text: req.proposedBody },
      ]
    : [{ type: "text", text: `[cognia GitHub Delivery] ${req.actionSummary}` }]
  return createDraft({
    conversationKey,
    sessionId: req.runId,
    segments,
    sourceMessageId: req.stepId,
    expiresAt: Date.now() + DEFAULT_EXPIRY_MS,
  })
}

function extractText(segments: MessageSegment[]): string {
  // The proposed body lives in segments[1] when present (index 0 is the
  // header). If the user collapsed the editor down to a single segment we
  // still pull the last text-bearing segment so they can't lose their
  // edit by re-shaping the draft.
  const bodySeg = segments.length > 1 ? segments[segments.length - 1] : segments[0]
  if (!bodySeg) return ""
  if (bodySeg.type === "text") return bodySeg.text
  if (bodySeg.type === "markdown") return bodySeg.md
  return ""
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
