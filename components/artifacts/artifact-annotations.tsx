"use client"

/**
 * The artifact preview's review queue — durable annotations against elements
 * the user pointed at.
 *
 * Sits beside, not instead of, the composer chips. Staging a pick into the
 * composer is the ephemeral path: it is consumed by the next message and its
 * whole job is to become an edit target so the reply can come back as a
 * revision proposal. An annotation is the opposite — it outlives the turn,
 * carries an intent and a severity, and ends in an outcome. Collapsing the two
 * would have meant losing one of them.
 *
 * The rows live in the same table as the embedded browser's annotations
 * (`lib/db/browser-annotations.ts`) and render through the same components,
 * because a review note about an element is the same thing whichever surface
 * the element was on. What is NOT shared is the query: readers take a scope
 * filter, so this queue can only ever contain this artifact's rows.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { AnnotationIntentControls } from "@/components/annotations/annotation-intent-controls"
import { AnnotationQueueList } from "@/components/annotations/annotation-queue-list"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useClientLiveQuery } from "@/hooks/data/use-client-live-query"
import { useSelectionToChat } from "@/hooks/browser/use-selection-to-chat"
import {
  deleteExpiredBrowserAnnotations,
  listActionableAnnotations,
  transitionBrowserAnnotation,
  type BrowserAnnotationIntent,
  type BrowserAnnotationSeverity,
  type BrowserAnnotationStatus,
} from "@/lib/db/browser-annotations"
import type { ElementSelectionCore } from "@/types/element-selection"

const EMPTY: never[] = []

export interface ArtifactAnnotationsProps {
  artifactId: string
  sessionId: string | null
  /** The most recent pick, offered for promotion into the queue. */
  lastPicked: ElementSelectionCore | null
  onQueued: () => void
}

export function ArtifactAnnotations({
  artifactId,
  sessionId,
  lastPicked,
  onQueued,
}: ArtifactAnnotationsProps) {
  const t = useTranslations("annotations")
  const tPick = useTranslations("artifacts.elementPick")
  const { queueAnnotation, sendAnnotations } = useSelectionToChat()

  const [comment, setComment] = useState("")
  const [intent, setIntent] = useState<BrowserAnnotationIntent>("change")
  const [severity, setSeverity] = useState<BrowserAnnotationSeverity>("suggestion")
  const [busy, setBusy] = useState(false)

  // The 30-day sweep used to run only when the embedded browser pane mounted.
  // Now that artifact annotations share the table, a user who never opens the
  // browser would accumulate rows that nothing ever expires.
  useEffect(() => {
    void deleteExpiredBrowserAnnotations(new Date().getTime())
  }, [])

  const annotations =
    useClientLiveQuery(
      () =>
        sessionId
          ? listActionableAnnotations(sessionId, { kind: "artifact", artifactId })
          : Promise.resolve(EMPTY),
      [sessionId, artifactId],
      EMPTY
    ) ?? EMPTY
  const pending = annotations.filter((annotation) => annotation.status === "pending")

  const add = useCallback(async () => {
    if (!lastPicked || !comment.trim() || !sessionId) return
    setBusy(true)
    try {
      await queueAnnotation(lastPicked, comment, {
        sessionId,
        // No `baseUrl`: this element was never on a page, and the queue's
        // readers scope on the target rather than the URL.
        target: { kind: "artifact", artifactId },
        intent,
        severity,
      })
      setComment("")
      onQueued()
    } finally {
      setBusy(false)
    }
  }, [artifactId, comment, intent, lastPicked, onQueued, queueAnnotation, sessionId, severity])

  const send = useCallback(async () => {
    if (pending.length === 0 || !sessionId) return
    setBusy(true)
    try {
      // No capture rect: an artifact preview has no native webview region to
      // screenshot, and `sendAnnotations` ships text-only without one.
      const sent = await sendAnnotations(pending, { sessionId, includeScreenshot: false })
      if (sent) toast.success(t("sent", { count: pending.length }))
    } finally {
      setBusy(false)
    }
  }, [pending, sendAnnotations, sessionId, t])

  const transition = useCallback(async (id: string, status: BrowserAnnotationStatus) => {
    await transitionBrowserAnnotation(id, status, new Date().getTime(), "human")
  }, [])

  if (!lastPicked && annotations.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground" data-testid="artifact-annotations-empty">
        {tPick("queueEmpty")}
      </p>
    )
  }

  return (
    <div data-testid="artifact-annotations">
      {lastPicked && (
        <div className="space-y-2 p-3">
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {lastPicked.componentName ? `<${lastPicked.componentName}>` : lastPicked.selector}
          </p>
          <Textarea
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder={tPick("queuePlaceholder")}
            aria-label={tPick("queuePlaceholder")}
            rows={2}
            className="resize-none text-sm"
          />
          <div className="flex items-center justify-between gap-2">
            <AnnotationIntentControls
              intent={intent}
              onIntentChange={setIntent}
              severity={severity}
              onSeverityChange={setSeverity}
              disabled={busy}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !comment.trim()}
              onClick={() => void add()}
              data-testid="artifact-annotation-add"
            >
              {t("add")}
            </Button>
          </div>
        </div>
      )}
      <AnnotationQueueList
        annotations={annotations}
        pendingCount={pending.length}
        busy={busy}
        onSend={() => void send()}
        onTransition={(id, status) => void transition(id, status)}
      />
    </div>
  )
}
