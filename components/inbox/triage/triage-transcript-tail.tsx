"use client"

/**
 * The last {@link TRIAGE_TRANSCRIPT_LIMIT} messages of the previewed
 * conversation, read-only, with a way into the full chat.
 *
 * `listRecentMessages` walks the `[sessionId+createdAt]` index backwards and
 * stops, so a long conversation costs the tail and not its whole history. It
 * runs inside a live query: an inbound message arriving while the operator
 * reads the preview appears without a refresh.
 *
 * Rendered by the shared `TranscriptMessageList` — the read-only lane remote
 * and observer surfaces use — so messages look exactly as they will in the
 * chat, with none of the active-chat actions.
 *
 * Two layouts, chosen by the pane:
 *  - `fill`: the transcript owns the column's height and scrolls itself,
 *    pinned to the newest message (the wide two-column pane).
 *  - `flow`: the transcript takes its natural height inside the pane's single
 *    scroller (the narrow stacked pane), so there is never a scroller nested
 *    inside another one.
 */

import { useLiveQuery } from "dexie-react-hooks"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import { ArrowUpRightIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { TranscriptMessageList } from "@/components/chat/transcript-message-list"
import { listRecentMessages } from "@/lib/db/messages"
import { cn } from "@/lib/utils"
import { TriageSectionHeading } from "./triage-section-heading"

export const TRIAGE_TRANSCRIPT_LIMIT = 30

export interface TriageTranscriptTailProps {
  sessionId: string
  layout: "fill" | "flow"
  onOpenInChat: () => void
}

export function TriageTranscriptTail({
  sessionId,
  layout,
  onOpenInChat,
}: TriageTranscriptTailProps) {
  const t = useTranslations("inbox.triage.transcript")
  const messages = useLiveQuery<UIMessage[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : listRecentMessages(sessionId, TRIAGE_TRANSCRIPT_LIMIT),
    [sessionId]
  )
  const fill = layout === "fill"

  let body: React.ReactNode
  if (messages === undefined) {
    body = (
      <div
        className="flex flex-col gap-3 px-4 py-3"
        role="status"
        aria-busy="true"
        aria-label={t("loading")}
        data-testid="triage-transcript-loading"
      >
        <Skeleton className="h-10 w-3/4" />
        <Skeleton className="ms-auto h-10 w-2/3" />
        <Skeleton className="h-10 w-1/2" />
      </div>
    )
  } else if (messages.length === 0) {
    body = (
      <p
        className="px-4 py-6 text-center text-sm text-muted-foreground"
        data-testid="triage-transcript-empty"
      >
        {t("empty")}
      </p>
    )
  } else {
    body = <TranscriptMessageList messages={messages} status="idle" sessionId={sessionId} />
  }

  return (
    <section
      aria-labelledby="triage-transcript-heading"
      className={cn("flex flex-col", fill && "min-h-0 flex-1")}
      data-testid="triage-transcript"
      data-layout={layout}
    >
      <TriageSectionHeading
        id="triage-transcript-heading"
        trailing={
          messages && messages.length >= TRIAGE_TRANSCRIPT_LIMIT ? (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {t("tailNote", { count: TRIAGE_TRANSCRIPT_LIMIT })}
            </span>
          ) : null
        }
      >
        {t("title")}
      </TriageSectionHeading>
      {/* `fill` gives the list a definite flex height to scroll in; `flow`
          leaves its `flex-1 overflow-y-auto` root in a block parent, where it
          simply grows to its content. */}
      <div className={cn(fill ? "flex min-h-0 flex-1 flex-col" : "block")}>{body}</div>
      <div className="flex shrink-0 justify-center border-t px-4 py-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={onOpenInChat}
          data-testid="triage-open-full-conversation"
        >
          {t("openFull")}
          <ArrowUpRightIcon className="size-3.5" aria-hidden />
        </Button>
      </div>
    </section>
  )
}
