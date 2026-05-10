"use client"

import { useCallback, useState } from "react"

import { approveDraft, rejectDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

export interface UseDraftApprovalOptions {
  /**
   * Side-effect run before `approveDraft` flips status. Receives the (possibly
   * edited) segments so callers like the desktop inbox can hand them to
   * `enqueueOutbound`. Throwing here aborts the approve and surfaces to caller.
   */
  beforeApprove?: (ctx: {
    draft: ConnectorDraftRow
    segments: MessageSegment[]
  }) => Promise<void> | void
  /** Side-effect run before `rejectDraft` flips status. */
  beforeReject?: (ctx: { draft: ConnectorDraftRow }) => Promise<void> | void
  /** Fires after the Dexie transition succeeds. */
  onComplete?: () => void
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
      await approveDraft(draft.id)
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
      await rejectDraft(draft.id)
      opts.onComplete?.()
    } finally {
      setBusy(false)
    }
  }, [draft, opts])

  return { segments, setSegment, busy, approve, reject }
}
