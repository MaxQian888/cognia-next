"use client"

import { useCallback, useState } from "react"

import { approveInboxDraft, rejectInboxDraft } from "@/lib/connectors/inbox-writes"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

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
}

export interface UseDraftApprovalResult {
  segments: MessageSegment[]
  setSegment: (index: number, text: string) => void
  busy: boolean
  approve: () => Promise<void>
  reject: () => Promise<void>
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

  const approve = useCallback(async () => {
    setBusy(true)
    try {
      if (opts.beforeApprove) {
        await opts.beforeApprove({ draft, segments })
      }
      // One call for every shell: a connector host enqueues the governed
      // outbound job and flips the draft; a thin client relays both to its
      // paired host under a draft-derived idempotency key. The EDITED
      // segments travel with it, so the phone's edits are what get sent.
      await approveInboxDraft(draft, { segments, label: opts.label })
      opts.onComplete?.()
    } finally {
      setBusy(false)
    }
  }, [draft, segments, opts])

  const reject = useCallback(async () => {
    setBusy(true)
    try {
      if (opts.beforeReject) {
        await opts.beforeReject({ draft })
      }
      await rejectInboxDraft(draft, { label: opts.label })
      opts.onComplete?.()
    } finally {
      setBusy(false)
    }
  }, [draft, opts])

  return { segments, setSegment, busy, approve, reject }
}
