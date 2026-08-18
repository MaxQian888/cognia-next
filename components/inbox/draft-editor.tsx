"use client"

/**
 * Draft editor for the Inbox — renders when a pending draft exists for
 * a conversation. Editable text/markdown segments; image/file/other segments
 * shown read-only.
 *
 * Buttons:
 *  - Approve & Send  → `approveInboxDraft` (ADR-0131) — enqueues the governed
 *                      outbound job on a connector host, relays it to the
 *                      paired host on a thin client, then marks "approved"
 *  - Reject          → `rejectInboxDraft`, marks "rejected"
 *  - Cancel          → onClose()
 */

import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemTitle } from "@/components/ui/item"
import { useDraftApproval } from "@/hooks/use-draft-approval"
import type { ConnectorDraftRow } from "@/lib/db/connector-types"

interface DraftEditorProps {
  draft: ConnectorDraftRow
  onClose: () => void
}

export function DraftEditor({ draft, onClose }: DraftEditorProps) {
  const t = useTranslations("inbox.draftEditor")
  // ADR-0131: the hook owns delivery for every shell now — this editor no
  // longer enqueues the outbound job itself, and the edited segments reach
  // the platform whether the runtime is here or on a paired host.
  const { segments, setSegment, busy, approve, reject } = useDraftApproval(draft, {
    onComplete: onClose,
    label: draft.conversationKey,
  })

  return (
    <div className="flex flex-col gap-3" data-testid="draft-editor">
      <div className="flex flex-col divide-y">
        {segments.map((seg, i) => {
          if (seg.type === "text") {
            return (
              <div key={i} className="py-3 first:pt-0 last:pb-0">
                <Textarea
                  value={seg.text}
                  onChange={(e) => setSegment(i, e.target.value)}
                  className="min-h-[80px] text-sm"
                  placeholder={t("textPlaceholder")}
                  data-testid={`draft-segment-text-${i}`}
                />
              </div>
            )
          }
          if (seg.type === "markdown") {
            return (
              <div key={i} className="py-3 first:pt-0 last:pb-0">
                <Textarea
                  value={seg.md}
                  onChange={(e) => setSegment(i, e.target.value)}
                  className="min-h-[80px] font-mono text-sm"
                  placeholder={t("markdownPlaceholder")}
                  data-testid={`draft-segment-markdown-${i}`}
                />
              </div>
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
              <Item
                key={i}
                size="sm"
                className="rounded-none px-0 py-3"
                data-testid={`draft-segment-a2ui-${i}`}
              >
                <ItemContent>
                  <ItemTitle className="max-w-full text-xs text-muted-foreground">
                    <Badge variant="outline">{t("a2uiBadge")}</Badge>
                    <span className="truncate font-mono">{seg.surfaceId}</span>
                  </ItemTitle>
                  <pre className="whitespace-pre-wrap break-words font-mono text-xs">
                    {seg.plainTextMirror || t("a2uiEmptyMirror")}
                  </pre>
                </ItemContent>
              </Item>
            )
          }
          return (
            <Item
              key={i}
              size="sm"
              className="rounded-none px-0 py-3 text-xs text-muted-foreground"
              data-testid={`draft-segment-readonly-${i}`}
            >
              <Badge variant="outline">{seg.type}</Badge>
              <ItemContent>
                <span className="truncate">
                  {seg.type === "image" || seg.type === "video" || seg.type === "voice"
                    ? seg.url
                    : seg.type === "file"
                      ? seg.name
                      : t("segmentFallback")}
                </span>
              </ItemContent>
            </Item>
          )
        })}
      </div>

      <div className="flex flex-wrap gap-2">
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
