import { Badge, Button, Progress } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import type { PendingAttachment } from "@ext/src/lib/panel/screenshots"

export type AttachAction = "visible" | "region" | "full-page" | "pdf"

export interface AttachmentsBarProps {
  api: BrowserApi
  attachments: PendingAttachment[]
  max: number
  /** The captured tab shows a PDF, which can be attached as the file itself. */
  canAttachPdf: boolean
  /** The action under way, if any. */
  busy: AttachAction | null
  /** Upload progress by attachment id, 0–1, while submitting. */
  progress: Record<string, number>
  onAttach: (action: AttachAction) => void
  onRemove: (id: string) => void
}

/** A `switch` with literal keys, so the locale coverage test can see them. */
function attachActionLabel(action: AttachAction, message: (key: string) => string): string {
  switch (action) {
    case "visible":
      return message("attachVisible")
    case "region":
      return message("attachRegion")
    case "full-page":
      return message("attachFullPage")
    case "pdf":
      return message("attachPdf")
  }
}

/**
 * What the submission carries besides text (ADR-0228 §3): screenshots of the
 * visible area, a region or the whole page, the PDF the tab shows, and an
 * image picked from the context menu. Shown as thumbnails with their size,
 * removable until sent; uploaded when the person submits.
 */
export function AttachmentsBar({
  api,
  attachments,
  max,
  canAttachPdf,
  busy,
  progress,
  onAttach,
  onRemove,
}: AttachmentsBarProps) {
  const full = attachments.length >= max
  const actions: AttachAction[] = [
    "visible",
    "region",
    "full-page",
    ...(canAttachPdf ? ["pdf" as const] : []),
  ]
  return (
    <div className="space-y-1.5" data-testid="attachments-bar">
      <div className="flex flex-wrap items-center gap-1">
        {actions.map((action) => (
          <Button
            key={action}
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            disabled={full || busy !== null}
            onClick={() => onAttach(action)}
            data-testid={`attach-${action}`}
          >
            {busy === action
              ? api.message("attachWorking")
              : attachActionLabel(action, api.message)}
          </Button>
        ))}
        {full ? (
          <span className="text-[11px] text-muted-foreground">{api.message("attachFull")}</span>
        ) : null}
      </div>
      {attachments.length > 0 ? (
        <ul className="grid grid-cols-3 gap-1.5">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="relative space-y-1 rounded-control border border-border p-1"
              data-testid={`attachment-${attachment.id}`}
            >
              {attachment.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- an extension page; next/image does not exist here
                <img
                  src={attachment.previewUrl}
                  alt={attachment.name}
                  className="h-14 w-full rounded object-cover object-top"
                />
              ) : (
                <div className="flex h-14 items-center justify-center rounded bg-muted text-[11px] font-medium">
                  PDF
                </div>
              )}
              <p className="truncate text-[10px]" title={attachment.name}>
                {attachment.name}
              </p>
              <Badge variant="outline" className="text-[10px]">
                {api.message("captureBytes", [(attachment.bytes.byteLength / 1024).toFixed(1)])}
              </Badge>
              {progress[attachment.id] !== undefined ? (
                <Progress
                  value={Math.round((progress[attachment.id] ?? 0) * 100)}
                  className="h-1"
                />
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-5 w-full px-1 text-[10px]"
                  onClick={() => onRemove(attachment.id)}
                  aria-label={api.message("attachRemove", [attachment.name])}
                  data-testid={`attachment-remove-${attachment.id}`}
                >
                  {api.message("remove")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
