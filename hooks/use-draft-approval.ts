"use client"

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { approveInboxDraft, rejectInboxDraft } from "@/lib/connectors/inbox-writes"
import type { InboxWriteRoute } from "@/lib/connectors/inbox-writes/route"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

export type DraftApprovalAction = "approve" | "reject"

/**
 * What an approve / reject came to. The calls never throw: both surfaces that
 * use this hook fire them from a button or a swipe (`void approve()`), so a
 * rejected promise used to become an unhandled rejection and the operator saw
 * nothing at all — the draft simply stayed put. The failure is toasted here
 * and returned, so a caller can still branch on it (move focus to the next
 * draft only on success, say).
 */
export type DraftApprovalOutcome =
  | { ok: true; action: DraftApprovalAction; route: Exclude<InboxWriteRoute, "unavailable"> }
  | { ok: false; action: DraftApprovalAction; error: unknown }

/** Editable segments compare by their text; everything else by identity. */
function sameSegment(a: MessageSegment, b: MessageSegment | undefined): boolean {
  if (a === b) return true
  if (!b || a.type !== b.type) return false
  if (a.type === "text" && b.type === "text") return a.text === b.text
  if (a.type === "markdown" && b.type === "markdown") return a.md === b.md
  return false
}

export interface UseDraftApprovalOptions {
  /**
   * Side-effect run BEFORE the draft is approved. Receives the (possibly
   * edited) segments. Throwing aborts the approve and surfaces to the caller.
   *
   * Delivery is NOT a job for this hook any more (ADR-0131): both the desktop
   * editor and the phone's panel used to run their own shell-specific enqueue
   * here — `enqueueOutbound` on one side, a `mobileOutboundQueue` row on the
   * other — which is exactly the branch the inbox-write facade removes.
   */
  beforeApprove?: (ctx: {
    draft: ConnectorDraftRow
    segments: MessageSegment[]
  }) => Promise<void> | void
  /** Side-effect run before the draft is rejected. */
  beforeReject?: (ctx: { draft: ConnectorDraftRow }) => Promise<void> | void
  /** Fires after the transition succeeds. */
  onComplete?: () => void
  /** Human label for the offline-queue UI on the relayed route. */
  label?: string
  /**
   * Toast the outcome (default true). A surface that reports the outcome its
   * own way turns this off and reads the returned {@link DraftApprovalOutcome}.
   */
  notify?: boolean
  /**
   * Label for a queued *reject*. Falls back to `label`, which is how every
   * rejected draft used to read "Approve connector draft" in the phone's
   * offline queue — the hook had one label for two opposite actions.
   */
  rejectLabel?: string
}

export interface UseDraftApprovalResult {
  segments: MessageSegment[]
  setSegment: (index: number, text: string) => void
  /** True once a segment differs from the draft as stored. */
  dirty: boolean
  /** Throw away local edits and return to the stored draft. */
  resetSegments: () => void
  busy: boolean
  approve: () => Promise<DraftApprovalOutcome>
  reject: () => Promise<DraftApprovalOutcome>
}

export function useDraftApproval(
  draft: ConnectorDraftRow,
  opts: UseDraftApprovalOptions = {}
): UseDraftApprovalResult {
  const [segments, setSegments] = useState<MessageSegment[]>(draft.segments)
  const [busy, setBusy] = useState(false)

  const setSegment = useCallback((index: number, text: string) => {
    setSegments((prev) => {
      if (index < 0 || index >= prev.length) return prev
      return prev.map((seg, i) => {
        if (i !== index) return seg
        if (seg.type === "text") return { ...seg, text }
        if (seg.type === "markdown") return { ...seg, md: text }
        return seg
      })
    })
  }, [])

  const t = useTranslations("inbox.draftApproval")
  const notify = opts.notify !== false

  const report = useCallback(
    (outcome: DraftApprovalOutcome): DraftApprovalOutcome => {
      if (!notify) return outcome
      if (outcome.ok) {
        // A relayed write is queued for the paired host, not delivered yet;
        // saying "sent" there would be a promise this device cannot keep.
        const key =
          outcome.action === "approve"
            ? outcome.route === "remote"
              ? "approveQueued"
              : "approved"
            : outcome.route === "remote"
              ? "rejectQueued"
              : "rejected"
        toast.success(t(key))
      } else {
        // Connector and transport errors are English and internal; the error
        // stays on the returned outcome for callers that log it.
        toast.error(t(outcome.action === "approve" ? "approveFailed" : "rejectFailed"), {
          description: t("failedFallback"),
        })
      }
      return outcome
    },
    [notify, t]
  )

  const approve = useCallback(async (): Promise<DraftApprovalOutcome> => {
    setBusy(true)
    try {
      if (opts.beforeApprove) {
        await opts.beforeApprove({ draft, segments })
      }
      // One call for every shell: a connector host enqueues the governed
      // outbound job and flips the draft; a thin client relays both to its
      // paired host under a draft-derived idempotency key. The EDITED
      // segments travel with it, so the phone's edits are what get sent.
      const result = await approveInboxDraft(draft, { segments, label: opts.label })
      opts.onComplete?.()
      return report({ ok: true, action: "approve", route: result.route })
    } catch (error) {
      return report({ ok: false, action: "approve", error })
    } finally {
      setBusy(false)
    }
  }, [draft, segments, opts, report])

  const reject = useCallback(async (): Promise<DraftApprovalOutcome> => {
    setBusy(true)
    try {
      if (opts.beforeReject) {
        await opts.beforeReject({ draft })
      }
      const result = await rejectInboxDraft(draft, { label: opts.rejectLabel ?? opts.label })
      opts.onComplete?.()
      return report({ ok: true, action: "reject", route: result.route })
    } catch (error) {
      return report({ ok: false, action: "reject", error })
    } finally {
      setBusy(false)
    }
  }, [draft, opts, report])

  const resetSegments = useCallback(() => setSegments(draft.segments), [draft.segments])
  const dirty = useMemo(
    () =>
      segments.length !== draft.segments.length ||
      segments.some((segment, index) => !sameSegment(segment, draft.segments[index])),
    [segments, draft.segments]
  )

  return { segments, setSegment, dirty, resetSegments, busy, approve, reject }
}
