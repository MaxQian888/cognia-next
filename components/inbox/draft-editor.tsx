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

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { useDraftApproval } from "@/hooks/use-draft-approval"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"

interface DraftEditorProps {
  draft: ConnectorDraftRow
  onClose: () => void
}

export function DraftEditor({ draft, onClose }: DraftEditorProps) {
  const { segments, setSegment, busy, approve, reject } = useDraftApproval(draft, {
    beforeApprove: async ({ segments: edited }) => {
      if (!draft.outboundPreview) return
      await enqueueOutbound({
        adapterId: draft.outboundPreview.conversationRef.adapterId,
        conversationKey: draft.conversationKey,
        request: { ...draft.outboundPreview, segments: edited },
      })
    },
    onComplete: onClose,
  })

  return (
    <div className="space-y-3" data-testid="draft-editor">
      <div className="space-y-2">
        {segments.map((seg, i) => {
          if (seg.type === "text") {
            return (
              <Textarea
                key={i}
                value={seg.text}
                onChange={(e) => setSegment(i, e.target.value)}
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
                onChange={(e) => setSegment(i, e.target.value)}
                className="min-h-[80px] font-mono text-sm"
                placeholder="Draft markdown…"
                data-testid={`draft-segment-markdown-${i}`}
              />
            )
          }
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
          onClick={() => void approve()}
          disabled={busy}
          data-testid="draft-approve-btn"
        >
          Approve &amp; Send
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => void reject()}
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
