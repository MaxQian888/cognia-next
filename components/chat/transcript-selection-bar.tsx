"use client"

/**
 * What to do with the messages ticked in selection mode.
 *
 * Floats at the foot of the message lane, where the jump pill otherwise sits,
 * and offers the four things a set of messages is for:
 *
 *  - **Reference** stages them as ONE chip (`message-set-reference.ts`).
 *  - **Summarize** answers in the same panel a text selection's summary uses,
 *    split between messages when the material is long, and the answer can be
 *    referenced in turn.
 *  - **Copy** puts them on the clipboard, each under who said it.
 *  - **Save as memory** files them as one pending draft.
 *
 * Each action that completes ends the mode, because it was what the selection
 * was for; a summary keeps it until its answer is referenced or closed. Esc
 * closes an open answer first and the mode second, and ⌘A / Ctrl+A ticks every
 * message — but never while typing, where both keys already mean something.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { BrainIcon, CheckCheckIcon, CopyIcon, QuoteIcon, SparklesIcon, XIcon } from "lucide-react"
import { createLogger } from "@cognia/logging"

import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { MessageSelectionResultPanel } from "@/components/chat/message-selection-result-panel"
import { useSelectionActionRun } from "@/hooks/chat/use-selection-action-run"
import { useCopy } from "@/hooks/ui/use-copy"
import { buildMessageExcerptSelection } from "@/lib/chat/selection/message-excerpt"
import { buildMessageSetReference } from "@/lib/chat/selection/message-set-reference"
import { selectionCopyText, selectionMaterial } from "@/lib/chat/selection/transcript-selection"
import { saveMessagesAsMemory } from "@/lib/chat/save-message-as-memory"
import { isEditableTarget } from "@/lib/shortcuts/dom"
import { cn } from "@/lib/utils"
import { useChatStore } from "@/stores/chat/chat-store"
import { useProjectStore } from "@/stores/project/project-store"

const log = createLogger("chat-transcript-selection")

export interface TranscriptSelectionBarProps {
  /** The conversation the messages belong to: references stage into its composer. */
  sessionId: string
  /** The ticked messages, in transcript order. */
  messages: readonly UIMessage[]
  /** How many messages can be ticked, so "Select all" knows when it is done. */
  selectableCount: number
  onSelectAll: () => void
  onClear: () => void
  onExit: () => void
  className?: string
}

export function TranscriptSelectionBar({
  sessionId,
  messages,
  selectableCount,
  onSelectAll,
  onClear,
  onExit,
  className,
}: TranscriptSelectionBarProps) {
  const t = useTranslations("chat.transcriptSelection")
  const { state: run, run: start, stop, close } = useSelectionActionRun()
  const { copy } = useCopy({ logger: log, scope: "chat" })
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const count = messages.length
  const none = count === 0
  const allTicked = count > 0 && count >= selectableCount
  const panelOpen = run.status !== "idle"

  /** One action at a time: a double click must not stage two chips or file two drafts. */
  const exclusive = useCallback(async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      await action()
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [])

  const onReference = useCallback(
    () =>
      exclusive(async () => {
        try {
          const selection = await buildMessageSetReference({
            sessionId,
            messageIds: messages.map((message) => message.id),
          })
          if (!selection) {
            toast.error(t("referenceEmpty"))
            return
          }
          useChatStore.getState().addContextSelection(selection, sessionId)
          toast.success(t("referenced", { count: selection.members?.length ?? 1 }))
          onExit()
        } catch (err) {
          log.error("transcript-selection-reference-failed", { sessionId, error: String(err) })
          toast.error(t("referenceFailed"))
        }
      }),
    [exclusive, messages, onExit, sessionId, t]
  )

  const onSummarize = useCallback(() => {
    const material = selectionMaterial(messages)
    void start({
      action: "summarize",
      quote: material.quote,
      segments: material.segments,
      sessionId,
      messageIds: material.messageIds,
      context: "",
    })
  }, [messages, sessionId, start])

  const onCopy = useCallback(
    () =>
      exclusive(async () => {
        const text = selectionCopyText(messages, {
          user: t("speaker.user"),
          assistant: t("speaker.assistant"),
          system: t("speaker.system"),
        })
        if (!text) {
          toast.error(t("copyEmpty"))
          return
        }
        if (await copy(text)) {
          toast.success(t("copied", { count }))
          onExit()
        } else {
          toast.error(t("copyFailed"))
        }
      }),
    [copy, count, exclusive, messages, onExit, t]
  )

  const onSaveMemory = useCallback(
    () =>
      exclusive(async () => {
        try {
          const { activeProjectId } = useProjectStore.getState()
          const title = await saveMessagesAsMemory({
            messages,
            sessionId,
            ...(activeProjectId ? { projectId: activeProjectId } : {}),
          })
          if (!title) {
            toast.error(t("memoryEmpty"))
            return
          }
          toast.success(t("memorySaved", { title }))
          onExit()
        } catch (err) {
          // A PII-gate refusal lands here, and it is an answer: nothing was filed.
          toast.error(
            t("memoryFailed", { reason: err instanceof Error ? err.message : String(err) })
          )
        }
      }),
    [exclusive, messages, onExit, sessionId, t]
  )

  const onReferenceSummary = useCallback(
    (text: string) =>
      exclusive(async () => {
        if (run.status === "idle") return
        try {
          const selection = await buildMessageExcerptSelection({
            sessionId,
            messageIds: run.request.messageIds,
            text,
            excerpt: { derivation: "summary", quote: run.request.quote },
          })
          if (!selection) {
            toast.error(t("referenceEmpty"))
            return
          }
          useChatStore.getState().addContextSelection(selection, sessionId)
          toast.success(t("summaryReferenced"))
          close()
          onExit()
        } catch (err) {
          log.error("transcript-selection-summary-reference-failed", {
            sessionId,
            error: String(err),
          })
          toast.error(t("referenceFailed"))
        }
      }),
    [close, exclusive, onExit, run, sessionId, t]
  )

  // Esc and ⌘A belong to whatever is being typed into; everywhere else in the
  // pane they act on the selection. An Esc a popover already handled is left
  // to it (the answer panel marks its own).
  const latest = useRef({ panelOpen, close, onExit, onSelectAll })
  useEffect(() => {
    latest.current = { panelOpen, close, onExit, onSelectAll }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || isEditableTarget(event.target)) return
      if (event.key === "Escape") {
        event.preventDefault()
        if (latest.current.panelOpen) latest.current.close()
        else latest.current.onExit()
        return
      }
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault()
        latest.current.onSelectAll()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3",
        className
      )}
    >
      <Popover open={panelOpen}>
        <PopoverAnchor asChild>
          <div
            role="toolbar"
            aria-label={t("toolbarLabel")}
            data-testid="transcript-selection-bar"
            className={cn(
              "pointer-events-auto flex max-w-full items-center gap-0.5 rounded-xl border p-1 shadow-lg",
              "bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85"
            )}
          >
            <span
              className="px-2 text-xs font-medium tabular-nums whitespace-nowrap"
              aria-live="polite"
              data-testid="transcript-selection-count"
            >
              {t("count", { count })}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={allTicked ? onClear : onSelectAll}
              aria-label={allTicked ? t("clear") : t("selectAll")}
              data-testid="transcript-selection-all"
            >
              <CheckCheckIcon className="size-3.5" aria-hidden />
              {/* The name is the button's own label; this is the same words, shown
                  once the pane is wide enough for them. */}
              <span className="hidden @2xl/message-list:inline" aria-hidden>
                {allTicked ? t("clear") : t("selectAll")}
              </span>
            </Button>
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <BarAction
              label={t("actions.reference")}
              icon={QuoteIcon}
              disabled={none || busy}
              onClick={() => void onReference()}
              testId="transcript-selection-reference"
            />
            <BarAction
              label={t("actions.summarize")}
              icon={SparklesIcon}
              disabled={none || busy}
              onClick={onSummarize}
              testId="transcript-selection-summarize"
            />
            <BarAction
              label={t("actions.copy")}
              icon={CopyIcon}
              disabled={none || busy}
              onClick={() => void onCopy()}
              testId="transcript-selection-copy"
            />
            <BarAction
              label={t("actions.saveMemory")}
              icon={BrainIcon}
              disabled={none || busy}
              onClick={() => void onSaveMemory()}
              testId="transcript-selection-saveMemory"
            />
            <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-8"
              aria-label={t("exit")}
              title={t("exit")}
              onClick={onExit}
              data-testid="transcript-selection-exit"
            >
              <XIcon className="size-3.5" />
            </Button>
          </div>
        </PopoverAnchor>
        {run.status !== "idle" ? (
          <PopoverContent
            side="top"
            align="center"
            sideOffset={8}
            collisionPadding={16}
            className="w-auto p-3"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            // Ticking more messages while reading the answer must not lose it.
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={(event) => {
              // Marked, so the bar's own Esc does not also end the mode.
              event.preventDefault()
              close()
            }}
          >
            <MessageSelectionResultPanel
              run={run}
              sourceLabel={t("sourceLabel", { count: run.request.messageIds.length })}
              onStop={stop}
              onRetry={() => void start(run.request)}
              onClose={close}
              onReference={(text) => void onReferenceSummary(text)}
              referencing={busy}
            />
          </PopoverContent>
        ) : null}
      </Popover>
    </div>
  )
}

/** One bulk action: its icon always, its label once the pane is wide enough. */
function BarAction({
  label,
  icon: Icon,
  disabled,
  onClick,
  testId,
}: {
  label: string
  icon: typeof QuoteIcon
  disabled: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-8 px-2 text-xs"
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={onClick}
      data-testid={testId}
    >
      <Icon className="size-3.5" aria-hidden />
      <span className="hidden @xl/message-list:inline" aria-hidden>
        {label}
      </span>
    </Button>
  )
}
