"use client"

/**
 * The Inbox's detail pane: a triage preview of one conversation.
 *
 * Since IM sessions open in the shared chat workspace, this pane had nothing
 * to show but "Select a conversation". It now answers the triage questions
 * without leaving the inbox: who is this, what did they last say, what does
 * the bot want to send, who owns it, is it on time, and is the plumbing
 * healthy. Replying is still the chat's job — "Reply in chat" (or Enter /
 * double-click on the row) opens it.
 *
 * No read side effects. The pane mounts neither `PlatformConversationContext`
 * nor anything that writes the active-conversation store: either would mark
 * the session read on sight and, worse, tell the bus the operator is looking
 * at it — silencing OS notifications and the phone push relay for a
 * conversation that was only glanced at. Read state changes only through the
 * explicit control in `TriageControls`.
 *
 * Layout follows the pane's own width, not the viewport (the desktop pane is
 * resizable):
 *  - wide: two columns — the transcript tail fills the left and scrolls
 *    itself, pinned to the newest message; the triage rail (properties,
 *    drafts, details) scrolls on the right.
 *  - narrow (tablet, a squeezed desktop pane, and the phone drawer that
 *    `layout="stacked"` exists for): one scroller, sections stacked and
 *    separated, the transcript in flow.
 *
 * Headed sections and separators on the pane's own ground — no cards.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { InboxIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { useElementWidth } from "@/hooks/use-element-width"
import { usePendingDrafts } from "@/hooks/connectors/use-pending-drafts"
import {
  useTriageConversation,
  type TriageConversation,
} from "@/hooks/inbox/use-triage-conversation"
import type { ConversationListSummary } from "@/lib/inbox/conversation-grouping"
import { isTauri } from "@/lib/tauri"
import { cn } from "@/lib/utils"
import { ContactProfileDrawer } from "../contact-profile-drawer"
import { ConversationOverrideDialog } from "../overrides/conversation-override-dialog"
import { CallbackBindingsInspector } from "../debug/callback-bindings-inspector"
import { StateCard } from "../state/state-card"
import { TriagePreviewHeader } from "./triage-preview-header"
import { TriageControls } from "./triage-controls"
import { TriageDraftsSection } from "./triage-drafts-section"
import { TriageTranscriptTail } from "./triage-transcript-tail"
import { TriageDetails } from "./triage-details"

/** Below this pane width the two-column layout leaves the transcript too narrow to read. */
export const TRIAGE_TWO_COLUMN_MIN_PX = 720

export interface TriagePreviewPaneProps {
  /** The previewed session (`?preview=`), or `null` for the empty state. */
  sessionId: string | null
  /** Counts for the empty state; `undefined` while the list loads. */
  summary?: ConversationListSummary
  onOpenInChat: (conversation: TriageConversation) => void
  /** Clears the preview. */
  onClose?: () => void
  /** `stacked` forces the single-column layout (a drawer host). */
  layout?: "auto" | "stacked"
}

export function TriagePreviewPane({
  sessionId,
  summary,
  onOpenInChat,
  onClose,
  layout = "auto",
}: TriagePreviewPaneProps) {
  const state = useTriageConversation(sessionId)

  if (state.status === "idle") {
    return <TriageEmptyState summary={summary} />
  }
  if (state.status === "loading") return <TriagePaneSkeleton />
  if (state.status === "missing") return <TriageMissingState onClose={onClose} />
  return (
    <TriageConversationView
      // A new conversation is a new pane: dialogs, the details disclosure and
      // inline draft edits must not carry over from the previous one.
      key={state.conversation.session.id}
      conversation={state.conversation}
      onOpenInChat={() => onOpenInChat(state.conversation)}
      onClose={onClose}
      layout={layout}
    />
  )
}

function TriageConversationView({
  conversation,
  onOpenInChat,
  onClose,
  layout,
}: {
  conversation: TriageConversation
  onOpenInChat: () => void
  onClose?: () => void
  layout: "auto" | "stacked"
}) {
  const desktop = isTauri()
  const bodyRef = useRef<HTMLDivElement>(null)
  const width = useElementWidth(bodyRef)
  // `0` is "not measured yet"; the measurement runs before paint, so treating
  // it as narrow never flashes.
  const twoColumn = layout === "auto" && width >= TRIAGE_TWO_COLUMN_MIN_PX
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [bindingsOpen, setBindingsOpen] = useState(false)
  const { session, conversationKey, adapterId, override } = conversation

  const triageSections = (
    <>
      <div className="px-4 py-2">
        <TriageControls conversation={conversation} onOpenSettings={() => setSettingsOpen(true)} />
      </div>
      <TriageDraftsSection conversationKey={conversationKey} />
    </>
  )
  const details = (
    <TriageDetails
      conversation={conversation}
      desktop={desktop}
      onOpenSettings={() => setSettingsOpen(true)}
      onOpenBindings={() => setBindingsOpen(true)}
    />
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="triage-preview-pane">
      <TriagePreviewHeader
        conversation={conversation}
        onOpenInChat={onOpenInChat}
        onOpenContact={() => setContactOpen(true)}
        onClose={onClose}
      />
      <div
        ref={bodyRef}
        className={cn(
          "flex min-h-0 flex-1",
          twoColumn ? "flex-row" : "flex-col overflow-y-auto overscroll-contain"
        )}
        data-testid="triage-preview-body"
        data-layout={twoColumn ? "two-column" : "stacked"}
      >
        {twoColumn ? (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              <TriageTranscriptTail
                sessionId={session.id}
                layout="fill"
                onOpenInChat={onOpenInChat}
              />
            </div>
            <aside
              className="flex w-80 shrink-0 flex-col overflow-y-auto overscroll-contain border-s xl:w-96"
              aria-label={conversation.session.title || conversationKey}
              data-testid="triage-rail"
            >
              {triageSections}
              <Separator />
              {details}
            </aside>
          </>
        ) : (
          <>
            {triageSections}
            <Separator />
            <TriageTranscriptTail
              sessionId={session.id}
              layout="flow"
              onOpenInChat={onOpenInChat}
            />
            <Separator />
            {details}
          </>
        )}
      </div>

      {/* Mounted here rather than in the controls so they survive the
          disclosure or rail that opened them re-rendering. */}
      <ConversationOverrideDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        adapterId={adapterId}
        conversationKey={conversationKey}
        sessionId={session.id}
        initialRow={override ?? null}
      />
      <ContactProfileDrawer
        open={contactOpen}
        onOpenChange={setContactOpen}
        conversationKey={conversationKey}
      />
      {adapterId && desktop && (
        <CallbackBindingsInspector
          open={bindingsOpen}
          onOpenChange={setBindingsOpen}
          conversationKey={conversationKey}
          adapterId={adapterId}
        />
      )}
    </div>
  )
}

/**
 * What the pane says before anything is selected: what it is for, how much is
 * waiting, and how to drive it — not just "Select a conversation".
 */
export function TriageEmptyState({ summary }: { summary?: ConversationListSummary }) {
  const t = useTranslations("inbox.triage.empty")
  // Read here, inside the pane's error boundary, rather than in the shell.
  const pendingDraftCount = usePendingDrafts().length
  const counts: Array<{ key: string; label: string; value: number }> = summary
    ? [
        { key: "unread", label: t("counts.unread"), value: summary.unread },
        { key: "pending", label: t("counts.pending"), value: summary.pending },
        { key: "snoozed", label: t("counts.snoozed"), value: summary.snoozed },
        { key: "drafts", label: t("counts.drafts"), value: pendingDraftCount },
      ]
    : []

  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10"
      data-testid="triage-empty"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-4 text-center">
        <InboxIcon className="size-8 text-muted-foreground" aria-hidden />
        <div className="space-y-1">
          <h2 className="text-sm font-medium">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>

        {summary ? (
          <dl
            className="grid w-full grid-cols-4 divide-x rounded-none border-y py-2"
            aria-label={t("countsAria", { total: summary.total })}
            data-testid="triage-empty-counts"
          >
            {counts.map((count) => (
              // `dt` before `dd` in the DOM (the list's reading order); the
              // number is drawn above its label with `flex-col-reverse`.
              <div key={count.key} className="flex flex-col-reverse items-center gap-0.5 px-1">
                <dt className="truncate text-[11px] text-muted-foreground">{count.label}</dt>
                <dd
                  className={cn(
                    "text-base font-semibold tabular-nums",
                    count.value === 0 && "text-muted-foreground"
                  )}
                  data-testid={`triage-empty-count-${count.key}`}
                >
                  {count.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}

        <ul
          className="w-full space-y-1.5 text-start text-xs text-muted-foreground"
          aria-label={t("hintsAria")}
        >
          <li className="flex items-center justify-between gap-3">
            <span>{t("hints.preview")}</span>
            <Kbd>{t("keys.click")}</Kbd>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>{t("hints.open")}</span>
            <span className="flex items-center gap-1">
              <Kbd>{t("keys.enter")}</Kbd>
              <span aria-hidden>/</span>
              <Kbd>{t("keys.doubleClick")}</Kbd>
            </span>
          </li>
        </ul>
      </div>
    </div>
  )
}

function TriagePaneSkeleton() {
  const t = useTranslations("inbox.triage")
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      role="status"
      aria-busy="true"
      aria-label={t("loading")}
      data-testid="triage-loading"
    >
      <div className="flex h-[var(--chrome-h)] shrink-0 items-center gap-2 border-b px-3">
        <Skeleton className="size-5 rounded-full" />
        <div className="flex-1 space-y-1.5">
          <Skeleton className="h-3.5 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="space-y-3 px-4 py-4">
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-7 w-32" />
          </div>
        ))}
      </div>
    </div>
  )
}

function TriageMissingState({ onClose }: { onClose?: () => void }) {
  const t = useTranslations("inbox.triage.missing")
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6"
      data-testid="triage-missing"
    >
      <StateCard.Empty className="flex-none" title={t("title")} description={t("description")} />
      {onClose ? (
        <Button variant="outline" size="sm" onClick={onClose} data-testid="triage-missing-clear">
          {t("clear")}
        </Button>
      ) : null}
    </div>
  )
}
