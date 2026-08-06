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

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { useDraftApproval } from "@/hooks/use-draft-approval"
import { enqueueGoverned as enqueueOutbound } from "@/lib/connectors/delivery-gateway"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"

interface DraftEditorProps {
  draft: ConnectorDraftRow
  onClose: () => void
}

export function DraftEditor({ draft, onClose }: DraftEditorProps) {
  const t = useTranslations("inbox.draftEditor")
  const { segments, setSegment, busy, approve, reject } = useDraftApproval(draft, {
    beforeApprove: async ({ segments: edited }) => {
      if (!draft.outboundPreview) return
      await enqueueOutbound({
        adapterId: draft.outboundPreview.conversationRef.adapterId,
        conversationKey: draft.conversationKey,
        request: { ...draft.outboundPreview, segments: edited },
        source: "draft-approved",
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
                placeholder={t("textPlaceholder")}
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
                placeholder={t("markdownPlaceholder")}
                data-testid={`draft-segment-markdown-${i}`}
              />
            )
          }
          if (seg.type === "a2ui") {
            // G5: draft preview for A2UI surfaces — show the pre-baked
            // `plainTextMirror` so the operator can see what users on
            // text-only channels will receive, plus a badge with the
            // surface id. The full interactive renderer mounts in the
            // main chat pane (ChatPane already handles A2UI parts);
            // we keep the draft editor lightweight + non-editable for
            // assistant-generated surfaces.
            return (
              <div
                key={i}
                className="space-y-2 rounded-md border bg-muted/40 px-3 py-2 text-xs"
                data-testid={`draft-segment-a2ui-${i}`}
              >
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Badge variant="outline">{t("a2uiBadge")}</Badge>
                  <span className="truncate font-mono">{seg.surfaceId}</span>
                </div>
                <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                  {seg.plainTextMirror || t("a2uiEmptyMirror")}
                </pre>
              </div>
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
          {t("approveAndSend")}
        </Button>
        <Button
          size="sm"
          variant="destructive"
          onClick={() => void reject()}
          disabled={busy}
          data-testid="draft-reject-btn"
        >
          {t("reject")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          disabled={busy}
          data-testid="draft-cancel-btn"
        >
          {t("cancel")}
        </Button>
      </div>
    </div>
  )
}
