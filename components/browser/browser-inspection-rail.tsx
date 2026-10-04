"use client"

import { SendIcon, XIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { type KeyboardEvent, useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { useLiveQuery } from "dexie-react-hooks"

import { AnnotationIntentControls } from "@/components/annotations/annotation-intent-controls"
import { AnnotationQueueList } from "@/components/annotations/annotation-queue-list"
import { BrowserAdjustControls } from "@/components/browser/browser-adjust-controls"
import { TooltipIconButton } from "@/components/chat/ui/tooltip-icon-button"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Textarea } from "@/components/ui/textarea"
import { type SendCommentOptions, useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import { type BrowserAdjustDriver, serializeBrowserAdjustmentFeedback } from "@/lib/browser/adjust"
import type { BrowserSelection, OutputDetailLevel } from "@/lib/browser/protocol"
import {
  deleteExpiredBrowserAnnotations,
  listActionableBrowserAnnotations,
  transitionBrowserAnnotation,
  type BrowserAnnotationIntent,
  type BrowserAnnotationSeverity,
  type BrowserAnnotationStatus,
} from "@/lib/db/browser-annotations"
import { cn } from "@/lib/utils"
import type { BrowserAdjustmentFeedback } from "@/types/browser-developer"

/** How a comment or a queued batch gets its one screenshot, decided at send time. */
export type InspectionCapture = Pick<SendCommentOptions, "capture" | "captureRect">

export interface BrowserInspectionRailProps {
  /** The element the card names (the last pick). */
  selection: BrowserSelection | null
  /** Every target of the last pick (shift-click, area, text). */
  selections: BrowserSelection[]
  /** Forget the picks, in the pane and in the page (comment sent or cancelled). */
  onClearSelection(): void
  /** The page's real address; an accepted adjustment is pinned to it. */
  pageUrl: string | null
  /** The chat session the annotations and Adjust drafts belong to. */
  sessionId: string | undefined
  /** Adjust's browser-session id. */
  browserSessionId: string
  /** The screenshot source; called when a comment or batch is sent. */
  capture(): InspectionCapture
  detailLevel: OutputDetailLevel
  /** The engine Adjust runs in; the embedded webview when omitted. */
  adjustDriver?: BrowserAdjustDriver
  /** Beside the page, or below it on a narrow pane. */
  placement: "side" | "bottom"
}

/**
 * The selection card (comment, Browser Adjust, intent, queue / send) and the
 * session's annotation queue, shared by the lightweight preview and local
 * Chromium (ADR-0214). It slides in when there is a pick or a queued
 * annotation and stays mounted through its slide-out so the exit animation
 * plays.
 */
export function BrowserInspectionRail({
  selection,
  selections,
  onClearSelection,
  pageUrl,
  sessionId,
  browserSessionId,
  capture,
  detailLevel,
  adjustDriver,
  placement,
}: BrowserInspectionRailProps) {
  const t = useTranslations("browser")
  // The annotation vocabulary is shared with the artifact preview.
  const tAnnotations = useTranslations("annotations")
  const { sendComment, queueAnnotation, sendAnnotations } = useSelectionToChat()
  const [comment, setComment] = useState("")
  const [acceptedAdjustment, setAcceptedAdjustment] = useState<{
    pageUrl: string
    feedback: BrowserAdjustmentFeedback
  } | null>(null)
  const [sending, setSending] = useState(false)
  const [annotationIntent, setAnnotationIntent] = useState<BrowserAnnotationIntent>("change")
  const [annotationSeverity, setAnnotationSeverity] =
    useState<BrowserAnnotationSeverity>("suggestion")

  const annotationQueue =
    useLiveQuery(
      () => (sessionId ? listActionableBrowserAnnotations(sessionId) : Promise.resolve([])),
      [sessionId],
      []
    ) ?? []
  const pendingAnnotations = annotationQueue.filter((annotation) => annotation.status === "pending")

  useEffect(() => {
    void deleteExpiredBrowserAnnotations(new Date().getTime())
  }, [])

  const adjustmentFeedback =
    acceptedAdjustment?.pageUrl === pageUrl ? acceptedAdjustment.feedback : null
  const acceptAdjustment = useCallback(
    (feedback: BrowserAdjustmentFeedback) => {
      if (!pageUrl) return
      setAcceptedAdjustment({ pageUrl, feedback })
    },
    [pageUrl]
  )

  // Set-state-during-render (not an effect): the "adjust state on prop
  // change" pattern, so the rail mounts in the same render it is wanted.
  const railWanted = !!selection || annotationQueue.length > 0
  const [railRendered, setRailRendered] = useState(railWanted)
  if (railWanted && !railRendered) setRailRendered(true)

  const finishComment = useCallback(() => {
    setComment("")
    setAcceptedAdjustment(null)
    onClearSelection()
  }, [onClearSelection])

  const outgoingComment = useCallback(() => {
    const feedbackPayload = adjustmentFeedback
      ? serializeBrowserAdjustmentFeedback(adjustmentFeedback)
      : ""
    return [comment.trim(), feedbackPayload].filter(Boolean).join("\n\n")
  }, [comment, adjustmentFeedback])

  const onQueue = useCallback(async () => {
    if (!selection || (!comment.trim() && !adjustmentFeedback)) return
    setSending(true)
    try {
      const baseUrl = new URL(pageUrl ?? selection.pageUrl).origin
      const text = outgoingComment()
      const targets = selections.length > 0 ? selections : [selection]
      const annotations = await Promise.all(
        targets.map((target) =>
          queueAnnotation(target, text, {
            sessionId,
            baseUrl,
            intent: annotationIntent,
            severity: annotationSeverity,
          })
        )
      )
      if (annotations.some((item) => item != null)) finishComment()
      else toast.error(t("comment.noSession"))
    } catch {
      toast.error(t("comment.failed"))
    } finally {
      setSending(false)
    }
  }, [
    selection,
    selections,
    comment,
    adjustmentFeedback,
    pageUrl,
    outgoingComment,
    queueAnnotation,
    sessionId,
    annotationIntent,
    annotationSeverity,
    finishComment,
    t,
  ])

  const onSend = useCallback(async () => {
    if (!selection || (!comment.trim() && !adjustmentFeedback)) return
    setSending(true)
    try {
      const ok = await sendComment(
        selections.length > 0 ? selections : selection,
        outgoingComment(),
        { sessionId, detailLevel, ...capture() }
      )
      if (ok) {
        toast.success(t("comment.sent"))
        finishComment()
      } else {
        toast.error(t("comment.noSession"))
      }
    } catch {
      toast.error(t("comment.failed"))
    } finally {
      setSending(false)
    }
  }, [
    selection,
    selections,
    comment,
    adjustmentFeedback,
    sendComment,
    outgoingComment,
    sessionId,
    detailLevel,
    capture,
    finishComment,
    t,
  ])

  const onSendQueue = useCallback(async () => {
    setSending(true)
    try {
      const ok = await sendAnnotations(pendingAnnotations, {
        sessionId,
        detailLevel,
        ...capture(),
      })
      if (ok) toast.success(tAnnotations("sent", { count: pendingAnnotations.length }))
      else toast.error(t("comment.noSession"))
    } catch {
      toast.error(t("comment.failed"))
    } finally {
      setSending(false)
    }
  }, [pendingAnnotations, sendAnnotations, sessionId, detailLevel, capture, t, tAnnotations])

  const transitionQueuedAnnotation = useCallback(
    async (id: string, status: BrowserAnnotationStatus) => {
      try {
        await transitionBrowserAnnotation(id, status, new Date().getTime(), "human")
      } catch {
        toast.error(t("comment.failed"))
      }
    },
    [t]
  )

  const onCommentKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        e.preventDefault()
        finishComment()
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        void onSend()
      }
    },
    [finishComment, onSend]
  )

  if (!railRendered) return null
  const blocked = sending || (!comment.trim() && !adjustmentFeedback)
  return (
    <aside
      data-testid="browser-inspection-rail"
      data-state={railWanted ? "open" : "closed"}
      role="region"
      aria-label={t("rail.label")}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && !railWanted) setRailRendered(false)
      }}
      className={cn(
        "flex shrink-0 flex-col overflow-hidden bg-background duration-200",
        "data-[state=open]:animate-in data-[state=open]:fade-in",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out",
        placement === "bottom"
          ? [
              "h-1/2 border-t",
              "data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom",
            ]
          : [
              "w-80 border-l",
              "data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right",
            ]
      )}
    >
      <ScrollArea className="min-h-0 flex-1">
        {selection && (
          <div className="bg-background p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
                  {selection.tagName.toLowerCase()}
                </Badge>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {selection.componentName ? `<${selection.componentName}>` : selection.selector}
                </p>
              </div>
              <TooltipIconButton
                tooltip={t("comment.cancel")}
                aria-label={t("comment.cancel")}
                size="icon-xs"
                onClick={finishComment}
              >
                <XIcon />
              </TooltipIconButton>
            </div>
            <Textarea
              autoFocus
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={onCommentKeyDown}
              placeholder={t("comment.placeholder")}
              aria-label={t("comment.title")}
              rows={2}
              className="resize-none text-sm"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">{t("comment.hint")}</p>
            {pageUrl && sessionId && (
              <BrowserAdjustControls
                sessionId={sessionId}
                browserSessionId={browserSessionId}
                pageUrl={pageUrl}
                selector={selection.selector}
                {...(adjustDriver ? { driver: adjustDriver } : {})}
                onAccept={acceptAdjustment}
              />
            )}
            {adjustmentFeedback && (
              <p className="mt-1 text-xs text-muted-foreground">{t("adjust.accepted")}</p>
            )}
            <div className="mt-2 flex items-center justify-between gap-2">
              <AnnotationIntentControls
                intent={annotationIntent}
                onIntentChange={setAnnotationIntent}
                severity={annotationSeverity}
                onSeverityChange={setAnnotationSeverity}
              />
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={blocked}
                  onClick={() => void onQueue()}
                >
                  {tAnnotations("add")}
                </Button>
                <Button size="sm" disabled={blocked} onClick={() => void onSend()}>
                  <SendIcon className="size-3.5" />
                  {t("comment.send")}
                </Button>
              </div>
            </div>
          </div>
        )}

        {annotationQueue.length > 0 && (
          <AnnotationQueueList
            annotations={annotationQueue}
            pendingCount={pendingAnnotations.length}
            busy={sending}
            onSend={() => void onSendQueue()}
            onTransition={(id, status) => void transitionQueuedAnnotation(id, status)}
          />
        )}
      </ScrollArea>
    </aside>
  )
}
