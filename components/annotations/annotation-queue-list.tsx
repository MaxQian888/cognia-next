"use client"

/**
 * The queued review annotations for one surface, with their outcomes.
 *
 * Shared by the embedded browser's inspection rail and the artifact preview:
 * the rows are the same rows (one Dexie table), the status machine is the same
 * machine, and a batch is sent through the same formatter. Only the QUERY
 * differs, and that belongs to the host — `listActionableAnnotations` takes a
 * scope filter precisely so one surface can never render the other's queue.
 */

import { useTranslations } from "next-intl"
import { CheckIcon, SendIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import type { BrowserAnnotationRow, BrowserAnnotationStatus } from "@/lib/db/browser-annotations"
import { cn } from "@/lib/utils"

export interface AnnotationQueueListProps {
  annotations: BrowserAnnotationRow[]
  /** The subset a send would actually ship — `pending` only. */
  pendingCount: number
  onSend: () => void
  onTransition: (id: string, status: BrowserAnnotationStatus) => void
  /** True while a send is in flight, so the controls cannot be double-fired. */
  busy?: boolean
  className?: string
}

export function AnnotationQueueList({
  annotations,
  pendingCount,
  onSend,
  onTransition,
  busy,
  className,
}: AnnotationQueueListProps) {
  const t = useTranslations("annotations")
  if (annotations.length === 0) return null

  return (
    <div className={cn("border-t bg-muted/30 p-3", className)} data-testid="annotation-queue">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{t("queued", { count: annotations.length })}</span>
        <Button
          size="sm"
          disabled={busy || pendingCount === 0}
          onClick={onSend}
          data-testid="annotation-queue-send"
        >
          <SendIcon className="size-3.5" />
          {t("send", { count: pendingCount })}
        </Button>
      </div>
      <div className="space-y-1">
        {annotations.map((annotation, index) => (
          <div
            key={annotation.id}
            className="flex items-center gap-2 text-xs"
            data-testid="annotation-queue-row"
          >
            <span className="min-w-0 flex-1 truncate">
              {index + 1}. {annotation.comment}
            </span>
            <Badge variant="outline" className="text-[10px]">
              {t(`status.${annotation.status}`)}
            </Badge>
            <Badge variant="outline" className="text-[10px]">
              {t(`intent.${annotation.intent}`)} · {t(`severity.${annotation.severity}`)}
            </Badge>
            <TooltipIconButton
              tooltip={t("resolve")}
              aria-label={t("resolve")}
              size="icon-xs"
              onClick={() => onTransition(annotation.id, "resolved")}
            >
              <CheckIcon />
            </TooltipIconButton>
            <TooltipIconButton
              tooltip={t("remove")}
              aria-label={t("remove")}
              size="icon-xs"
              onClick={() => onTransition(annotation.id, "dismissed")}
            >
              <Trash2Icon />
            </TooltipIconButton>
          </div>
        ))}
      </div>
    </div>
  )
}
