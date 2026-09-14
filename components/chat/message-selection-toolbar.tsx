"use client"

// The capsule that appears over text selected in the transcript.
//
// Selecting part of a reply used to offer one thing: ask about it in an aside —
// and even that lost the quote whenever the aside's composer mounted after the
// event announcing it. What people actually do with a selected passage is
// bring it into the conversation, or find out what it says. So the capsule
// offers exactly those:
//
//   Reference   stage the passage as a chip in THIS conversation's composer
//   Aside       open an aside seeded with the passage as a quote
//   Summarize / Explain / Translate
//               answer in a panel beside the selection, which can then be
//               copied or referenced in turn
//
// The capsule and the panel are portaled popovers anchored to the live selection
// range. They used to be `position: fixed` inside the transcript, whose
// container-query ancestor establishes a containing block for fixed children,
// so the button drifted away from the text it was about.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import {
  ChevronDownIcon,
  LanguagesIcon,
  MessagesSquareIcon,
  QuoteIcon,
  ScrollTextIcon,
  SparklesIcon,
} from "lucide-react"
import type { SessionSurfaceBinding } from "@cognia/agent-config-types"
import { createLogger } from "@cognia/logging"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { MessageSelectionResultPanel } from "@/components/chat/message-selection-result-panel"
import {
  TARGET_LOCALES,
  type TargetLocale,
} from "@/components/selection-toolbar/selection-toolbar-actions"
import { useMessageSelectionActions } from "@/hooks/chat/use-message-selection-actions"
import { createResourceWorkbenchSession } from "@/lib/db/resource-workbench-sessions"
import {
  isDeliberateSelection,
  quoteSelection,
  selectionTitleFor,
} from "@/lib/chat/selection/selection-text"
import type { SelectionAction } from "@/lib/chat/selection/run-selection-action"
import { getContextResourceKey } from "@/types/context-workbench"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { useChatStore } from "@/stores/chat/chat-store"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

const log = createLogger("chat-selection")

/** A viewport rectangle, detached from the DOM that produced it. */
export interface SelectionRect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface SelectionAnchor {
  text: string
  /** The selection's last line box when it was made — the fallback placement. */
  rect: SelectionRect
  /** Every message the selection touches, in transcript order. */
  messageIds: string[]
  /** Those messages' rendered text, which an explanation reads for context. */
  context: string
  /** The live range, so a popover follows the text as the transcript scrolls. */
  range: Range | null
}

function rectOf(range: Range): SelectionRect | null {
  // Geometry is for placement only, and it is the one part of this a non-browser
  // DOM may not implement (jsdom has no `Range.getClientRects`). Throwing here
  // would abort a `selectionchange` listener over a button position.
  if (typeof range.getClientRects !== "function") return null
  const last = Array.from(range.getClientRects()).at(-1)
  if (!last || (last.width === 0 && last.height === 0)) return null
  return { left: last.left, top: last.top, right: last.right, bottom: last.bottom }
}

/** The rows a range touches, in document order, each once. */
export function messageRowsInRange(container: HTMLElement, range: Range): HTMLElement[] {
  const rows = Array.from(container.querySelectorAll<HTMLElement>("[data-msg-id]"))
  const touched =
    typeof range.intersectsNode === "function"
      ? rows.filter((row) => range.intersectsNode(row))
      : rows.filter((row) => row.contains(range.startContainer) || row.contains(range.endContainer))
  // A row nested inside another row (a live tail inside its wrapper) is the same
  // message; keep the outermost.
  return touched.filter((row) => !touched.some((other) => other !== row && other.contains(row)))
}

/**
 * Track the current selection within `containerRef`.
 *
 * Null unless the selection is non-empty, long enough to be deliberate, and
 * entirely inside the transcript — a selection that starts in a message and
 * ends in the composer is not about a message.
 */
export function useTranscriptSelection(
  containerRef: React.RefObject<HTMLElement | null>
): SelectionAnchor | null {
  const [anchor, setAnchor] = useState<SelectionAnchor | null>(null)

  useEffect(() => {
    const read = () => {
      const container = containerRef.current
      const selection = window.getSelection()
      if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
        setAnchor(null)
        return
      }
      const range = selection.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) {
        setAnchor(null)
        return
      }
      const text = selection.toString().trim()
      if (!isDeliberateSelection(text)) {
        setAnchor(null)
        return
      }
      const rows = messageRowsInRange(container, range)
      const ids = [...new Set(rows.map((row) => row.dataset.msgId!).filter(Boolean))]
      setAnchor({
        text,
        rect: rectOf(range) ?? { left: 0, top: 0, right: 0, bottom: 0 },
        messageIds: ids,
        context: rows.map((row) => row.textContent?.trim() ?? "").join("\n\n"),
        range: range.cloneRange(),
      })
    }

    // `selectionchange` is the only event that fires for keyboard selection and
    // for a drag that ends outside the container.
    document.addEventListener("selectionchange", read)
    return () => document.removeEventListener("selectionchange", read)
  }, [containerRef])

  return anchor
}

/** A popper anchor that follows the live range, and holds its place once the range is gone. */
function virtualAnchorFor(anchor: SelectionAnchor) {
  let last = anchor.rect
  return {
    getBoundingClientRect: () => {
      const live = anchor.range ? rectOf(anchor.range) : null
      if (live) last = live
      const { left, top, right, bottom } = last
      return {
        x: left,
        y: top,
        left,
        top,
        right,
        bottom,
        width: right - left,
        height: bottom - top,
        toJSON: () => last,
      } as DOMRect
    },
  }
}

function mintId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `sel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface MessageSelectionToolbarProps {
  /** The conversation the selection lives in: chips stage into its composer. */
  sessionId: string
  containerRef: React.RefObject<HTMLElement | null>
  /**
   * Whether "Ask in an aside" is offered. An aside cannot own an aside, so a
   * transcript that IS an aside gets every other action.
   */
  allowAside?: boolean
}

export function MessageSelectionToolbar({
  sessionId,
  containerRef,
  allowAside = true,
}: MessageSelectionToolbarProps) {
  const t = useTranslations("chat.selection")
  const tLanguage = useTranslations("selectionToolbar.languages")
  const anchor = useTranscriptSelection(containerRef)
  const {
    run,
    start,
    retry,
    stop,
    close,
    targetLocale,
    chooseLocale,
    languageLabel,
    referencePassage,
    referenceResult,
    referencing,
  } = useMessageSelectionActions({ sessionId })
  const [panelAnchor, setPanelAnchor] = useState<SelectionAnchor | null>(null)
  const busyRef = useRef(false)

  const onReference = useCallback(async () => {
    if (!anchor || busyRef.current) return
    busyRef.current = true
    try {
      if (await referencePassage(anchor)) window.getSelection()?.removeAllRanges()
    } finally {
      busyRef.current = false
    }
  }, [anchor, referencePassage])

  const onAsk = useCallback(async () => {
    if (!anchor || busyRef.current) return
    busyRef.current = true
    try {
      const binding: SessionSurfaceBinding = { kind: "session", sessionId }
      const aside = await createResourceWorkbenchSession(binding, selectionTitleFor(anchor.text))
      // Staged against the aside's id rather than dispatched as an event: the
      // aside's composer mounts AFTER this, and an event fired now reached no
      // one. The composer consumes a pending intent once its draft hydrates.
      useComposerIntentStore
        .getState()
        .stage(aside.id, { candidateId: mintId(), prompt: `${quoteSelection(anchor.text)}\n\n` })
      useContextWorkbenchStore
        .getState()
        .setSessionOverride(
          getContextResourceKey({ kind: "session", capabilities: ["ai"], sessionId }),
          aside.id
        )
      // The dock follows the focused conversation, so only bring it forward
      // when that is the one the selection was made in.
      if (useChatStore.getState().activeSessionId === sessionId) {
        useArtifactDockLayoutStore.getState().revealSidechat()
      }
      window.getSelection()?.removeAllRanges()
    } catch (err) {
      log.error("selection-aside-failed", { sessionId, error: String(err) })
      toast.error(t("askError"))
    } finally {
      busyRef.current = false
    }
  }, [anchor, sessionId, t])

  const onRun = useCallback(
    (action: SelectionAction, chosenLocale?: TargetLocale) => {
      if (!anchor) return
      setPanelAnchor(anchor)
      start(action, anchor, chosenLocale)
    },
    [anchor, start]
  )

  const onReferenceResult = useCallback(
    async (text: string) => {
      if (await referenceResult(text)) setPanelAnchor(null)
    },
    [referenceResult]
  )

  const onClosePanel = useCallback(() => {
    close()
    setPanelAnchor(null)
  }, [close])

  const panelOpen = run.status !== "idle" && panelAnchor !== null
  // The capsule steps aside while its own answer is showing for the same text;
  // a new selection brings it back.
  const capsuleOpen = Boolean(anchor) && !(panelOpen && panelAnchor?.text === anchor?.text)
  const capsuleVirtual = useMemo(() => (anchor ? virtualAnchorFor(anchor) : null), [anchor])
  const panelVirtual = useMemo(
    () => (panelAnchor ? virtualAnchorFor(panelAnchor) : null),
    [panelAnchor]
  )
  const canReference = Boolean(anchor && anchor.messageIds.length > 0)

  return (
    <>
      <Popover open={capsuleOpen}>
        {capsuleVirtual ? <PopoverAnchor virtualRef={{ current: capsuleVirtual }} /> : null}
        <PopoverContent
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={16}
          className="w-auto max-w-[min(92vw,560px)] rounded-lg p-1"
          data-testid="message-selection-toolbar"
          // Focus stays in the transcript: moving it would not clear the
          // selection, but it would steal the keyboard from someone extending it.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={() => window.getSelection()?.removeAllRanges()}
        >
          <div
            role="toolbar"
            aria-label={t("toolbarLabel")}
            className="flex flex-wrap items-center gap-0.5"
            // A mouse-down anywhere in the capsule would otherwise collapse the
            // selection before a button's click handler reads it.
            onMouseDown={(event) => event.preventDefault()}
          >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={!canReference}
              onClick={() => void onReference()}
            >
              <QuoteIcon className="size-3.5" />
              {t("reference")}
            </Button>
            {allowAside ? (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 px-2 text-xs"
                onClick={() => void onAsk()}
              >
                <MessagesSquareIcon className="size-3.5" />
                {t("askInAside")}
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => onRun("summarize")}
            >
              <ScrollTextIcon className="size-3.5" />
              {t("summarize")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5 px-2 text-xs"
              onClick={() => onRun("explain")}
            >
              <SparklesIcon className="size-3.5" />
              {t("explain")}
            </Button>
            <div className="flex items-center">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 rounded-e-none px-2 text-xs"
                title={t("translateInto", { language: tLanguage(targetLocale) })}
                onClick={() => onRun("translate")}
              >
                <LanguagesIcon className="size-3.5" />
                {t("translate")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 rounded-s-none px-1"
                    aria-label={t("chooseLanguage")}
                  >
                    <ChevronDownIcon className="size-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="end"
                  onCloseAutoFocus={(event) => event.preventDefault()}
                >
                  <DropdownMenuLabel className="text-xs">{t("chooseLanguage")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={targetLocale}
                    onValueChange={(next) => {
                      chooseLocale(next)
                      onRun("translate", next as TargetLocale)
                    }}
                  >
                    {TARGET_LOCALES.map((tag) => (
                      <DropdownMenuRadioItem key={tag} value={tag} className="text-xs">
                        {tLanguage(tag)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <Popover open={panelOpen}>
        {panelVirtual ? <PopoverAnchor virtualRef={{ current: panelVirtual }} /> : null}
        {run.status !== "idle" ? (
          <PopoverContent
            side="bottom"
            align="start"
            sideOffset={8}
            collisionPadding={16}
            className="w-auto p-3"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            // Reading an answer and then selecting more of the transcript must
            // not throw the answer away; the panel closes on Escape or its ✕.
            onInteractOutside={(event) => event.preventDefault()}
            onEscapeKeyDown={onClosePanel}
          >
            <MessageSelectionResultPanel
              run={run}
              languageLabel={languageLabel(run.request.targetLocale)}
              onStop={stop}
              onRetry={retry}
              onClose={onClosePanel}
              onReference={(text) => void onReferenceResult(text)}
              referencing={referencing}
            />
          </PopoverContent>
        ) : null}
      </Popover>
    </>
  )
}
