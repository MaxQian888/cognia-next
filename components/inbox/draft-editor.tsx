"use client"

/**
 * Draft editor for the Inbox — renders when a pending draft exists for
 * a conversation. Editable text/markdown segments; image/file/other segments
 * shown read-only.
 *
 * Buttons:
 *  - Approve & Send  → enqueueOutbound (via the draft's outboundPreview) +
 *                      markDraft "approved"
 *  - Reject          → markDraft "rejected"
 *  - Cancel          → onClose()
 */

import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { approveDraft, rejectDraft } from "@/lib/db/connector-drafts"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"
import type { MessageSegment } from "@/types/connectors/segment"

interface DraftEditorProps {
  draft: ConnectorDraftRow
  onClose: () => void
}

export function DraftEditor({ draft, onClose }: DraftEditorProps) {
  // Build editable state: only text/markdown segments are mutable.
  const [segments, setSegments] = useState<MessageSegment[]>(draft.segments)
  const [busy, setBusy] = useState(false)

  const updateSegment = (index: number, text: string) => {
    setSegments((prev) =>
      prev.map((seg, i) => {
        if (i !== index) return seg
        if (seg.type === "text") return { ...seg, text }
        if (seg.type === "markdown") return { ...seg, md: text }
        return seg
      })
    )
  }

  const handleApprove = async () => {
    setBusy(true)
    try {
      if (draft.outboundPreview) {
        // Build updated request with edited segments.
        const updatedRequest = {
          ...draft.outboundPreview,
          segments,
        }
        await enqueueOutbound({
          adapterId: updatedRequest.conversationRef.adapterId,
          conversationKey: draft.conversationKey,
          request: updatedRequest,
        })
      }
      await approveDraft(draft.id)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleReject = async () => {
    setBusy(true)
    try {
      await rejectDraft(draft.id)
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3" data-testid="draft-editor">
      <div className="space-y-2">
        {segments.map((seg, i) => {
          if (seg.type === "text") {
            return (
              <Textarea
                key={i}
                value={seg.text}
                onChange={(e) => updateSegment(i, e.target.value)}
                className="min-h-[80px] text-sm"
                placeholder="Draft text…"
                data-testid={`draft-segment-text-${i}`}
              />
            )
          }
          if (seg.type === "markdown") {
            return (
              <Textarea
                key={i}
                value={seg.md}
                onChange={(e) => updateSegment(i, e.target.value)}
                className="min-h-[80px] font-mono text-sm"
                placeholder="Draft markdown…"
                data-testid={`draft-segment-markdown-${i}`}
              />
            )
          }
          // Read-only segment
          return (
            <div
              key={i}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs text-muted-foreground"
              data-testid={`draft-segment-readonly-${i}`}
            >
              <Badge variant="outline">{seg.type}</Badge>
              <span className="truncate">
                {seg.type === "image" || seg.type === "video" || seg.type === "voice"
                  ? seg.url
                  : seg.type === "file"
                    ? seg.name
                    : "[segment]"}
              </span>
            </div>
          )
        })}
      </div>

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => void handleApprove()}
          disabled={busy}
          data-testid="draft-approve-btn"
        >
          Approve &amp; Send
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => void handleReject()}
          disabled={busy}
          data-testid="draft-reject-btn"
        >
          Reject
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={busy}
          data-testid="draft-cancel-btn"
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
