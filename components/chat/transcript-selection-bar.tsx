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
 * closes an open answer first and the mode second — from anywhere but a field
 * with something typed in it, where Esc belongs to the draft — and ⌘A / Ctrl+A
 * ticks every message unless focus is in a field at all.
 *
 * It is drawn in the inverse of the page so it cannot be mistaken for a second
 * composer, which it sits just above. Wide panes get one pill with the leaving ✕
 * first; a narrow pane (a phone, a split view) gets a floating card whose
 * actions keep their labels, because a row of bare icons is guesswork on touch.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { motion, useIsPresent } from "motion/react"
import type { UIMessage } from "ai"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { BrainIcon, CopyIcon, QuoteIcon, SparklesIcon, XIcon } from "lucide-react"
import { createLogger } from "@cognia/logging"

import { Button } from "@/components/ui/button"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import {
  FLOATING_BAR_BUTTON_CLASS,
  FLOATING_BAR_CLASS,
  FloatingBarAction,
} from "@/components/chat/floating-action-bar"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { MessageSelectionResultPanel } from "@/components/chat/message-selection-result-panel"
import { useSelectionActionRun } from "@/hooks/chat/use-selection-action-run"
import { useCopy } from "@/hooks/ui/use-copy"
import { buildMessageExcerptSelection } from "@/lib/chat/selection/message-excerpt"
import { buildMessageSetReference } from "@/lib/chat/selection/message-set-reference"
import { selectionCopyText, selectionMaterial } from "@/lib/chat/selection/transcript-selection"
import { saveMessagesAsMemory } from "@/lib/chat/save-message-as-memory"
import { isEditableTarget } from "@/lib/shortcuts/dom"
import { MOBILE_SPRING } from "@/lib/ui/motion"
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
  const { reduce } = useFlowMotion()
  // Still mounted while it animates out: by then it acts on nothing, or a ⌘A in
  // that moment would tick every message of a mode that already ended.
  const isPresent = useIsPresent()

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
  const latest = useRef({ panelOpen, close, onExit, onSelectAll, isPresent })
  useEffect(() => {
    latest.current = { panelOpen, close, onExit, onSelectAll, isPresent }
  })
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !latest.current.isPresent) return
      if (event.key === "Escape") {
        // An empty composer has nothing for Esc to discard, and focus lands there
        // by habit — refusing it would leave the mode with no keyboard way out.
        if (isEditableTarget(event.target) && editableHasText(event.target)) return
        event.preventDefault()
        if (latest.current.panelOpen) latest.current.close()
        else latest.current.onExit()
        return
      }
      if (isEditableTarget(event.target)) return
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "a") {
        event.preventDefault()
        latest.current.onSelectAll()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])

  const actionsDisabled = none || busy || !isPresent
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3",
        className
      )}
    >
      <Popover open={panelOpen}>
        <PopoverAnchor asChild>
          <motion.div
            role="toolbar"
            aria-label={t("toolbarLabel")}
            data-testid="transcript-selection-bar"
            data-elevation="3"
            initial={reduce ? false : { opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 16, scale: 0.96 }}
            transition={reduce ? { duration: 0.12 } : MOBILE_SPRING}
            className={cn(
              "flex w-full flex-col gap-1 rounded-panel p-1.5",
              FLOATING_BAR_CLASS,
              "@xl/message-list:w-auto @xl/message-list:max-w-full @xl/message-list:flex-row @xl/message-list:items-center @xl/message-list:gap-0.5 @xl/message-list:rounded-pill @xl/message-list:p-1",
              isPresent ? "pointer-events-auto" : "pointer-events-none"
            )}
          >
            <div className="flex min-w-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn(
                  FLOATING_BAR_BUTTON_CLASS,
                  "size-8 shrink-0 rounded-full pointer-coarse:size-11"
                )}
                aria-label={t("exit")}
                title={t("exitHint")}
                onClick={onExit}
                disabled={!isPresent}
                data-testid="transcript-selection-exit"
              >
                <XIcon className="size-4" aria-hidden />
              </Button>
              <span
                className="min-w-0 truncate px-1.5 text-sm font-medium tabular-nums"
                aria-live="polite"
                data-testid="transcript-selection-count"
              >
                {/* Keyed on the count, so each tick lands with a small drop. */}
                <motion.span
                  key={count}
                  className="inline-block"
                  initial={reduce ? false : { y: -6, opacity: 0.4 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={MOBILE_SPRING}
                >
                  {t("count", { count })}
                </motion.span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn(
                  FLOATING_BAR_BUTTON_CLASS,
                  "ml-auto h-8 shrink-0 rounded-pill px-2.5 text-xs text-background/70 pointer-coarse:h-11"
                )}
                onClick={allTicked ? onClear : onSelectAll}
                disabled={!isPresent || selectableCount === 0}
                data-testid="transcript-selection-all"
              >
                {allTicked ? t("clear") : t("selectAll")}
              </Button>
            </div>
            <span
              className="hidden h-5 w-px shrink-0 bg-background/20 @xl/message-list:mx-1 @xl/message-list:block"
              aria-hidden
            />
            <div className="grid grid-cols-4 gap-0.5 @xl/message-list:flex @xl/message-list:items-center">
              <FloatingBarAction
                adaptive
                label={t("actions.reference")}
                icon={QuoteIcon}
                disabled={actionsDisabled}
                onClick={() => void onReference()}
                data-testid="transcript-selection-reference"
              />
              <FloatingBarAction
                adaptive
                label={t("actions.summarize")}
                icon={SparklesIcon}
                disabled={actionsDisabled}
                onClick={onSummarize}
                data-testid="transcript-selection-summarize"
              />
              <FloatingBarAction
                adaptive
                label={t("actions.copy")}
                icon={CopyIcon}
                disabled={actionsDisabled}
                onClick={() => void onCopy()}
                data-testid="transcript-selection-copy"
              />
              <FloatingBarAction
                adaptive
                label={t("actions.saveMemory")}
                icon={BrainIcon}
                disabled={actionsDisabled}
                onClick={() => void onSaveMemory()}
                data-testid="transcript-selection-saveMemory"
              />
            </div>
          </motion.div>
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

/** Whether a field Esc might be aimed at holds anything to discard. */
function editableHasText(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return target.value.length > 0
  }
  return target instanceof HTMLElement && (target.textContent ?? "").trim().length > 0
}
