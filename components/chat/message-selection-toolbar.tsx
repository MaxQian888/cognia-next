"use client"

// Floating action for a text selection inside the transcript.
//
// The chat surface had no selection affordance at all: the only precedent in
// the repo is `components/artifacts/selection-comment-button.tsx`, and it is
// bound to an artifact. Selecting a paragraph of a reply and asking about *that*
// meant copying it, opening the dock, and pasting.
//
// One action, deliberately: "ask about this in an aside". Quoting into the
// composer is what the per-message bring-back already does, and a second way to
// do it here would just be a smaller version of the same button.

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { MessagesSquareIcon } from "lucide-react"
import type { SessionSurfaceBinding } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import { createResourceWorkbenchSession } from "@/lib/db/resource-workbench-sessions"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { getContextResourceKey } from "@/types/context-workbench"
import { dispatchComposerAppend } from "@/components/chat/composer"
import { createLogger } from "@cognia/logging"

const log = createLogger("chat-selection")

/** Longest selection used verbatim as an aside's name before it is elided. */
const TITLE_MAX = 48

/** Selection long enough to be worth an aside — below this it is a mis-drag. */
const MIN_SELECTION = 3

export interface SelectionAnchor {
  text: string
  /** Viewport coordinates of the selection's end, for placing the button. */
  x: number
  y: number
}

/** Name an aside after what was selected, elided on a word boundary. */
export function asideTitleFor(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  if (flat.length <= TITLE_MAX) return flat
  const cut = flat.slice(0, TITLE_MAX)
  const lastSpace = cut.lastIndexOf(" ")
  return `${(lastSpace > TITLE_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * Track the current selection within `containerRef`.
 *
 * Returns null unless the selection is non-empty, long enough to be deliberate,
 * and entirely inside the transcript — a selection that starts in a message and
 * ends in the composer is not a question about a message.
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
      if (text.length < MIN_SELECTION) {
        setAnchor(null)
        return
      }
      // Geometry is for placement only, and it is the one part of this that a
      // non-browser DOM may not implement (jsdom has no `Range.getClientRects`
      // at all). Throwing here would abort a `selectionchange` listener —
      // taking every later listener on the event with it — over a button
      // position, so degrade to the origin instead.
      const last =
        typeof range.getClientRects === "function"
          ? Array.from(range.getClientRects()).at(-1)
          : undefined
      setAnchor({ text, x: last?.right ?? 0, y: last?.bottom ?? 0 })
    }

    // `selectionchange` is the only event that fires for keyboard selection and
    // for a drag that ends outside the container.
    document.addEventListener("selectionchange", read)
    return () => document.removeEventListener("selectionchange", read)
  }, [containerRef])

  return anchor
}

export function MessageSelectionToolbar({
  sessionId,
  containerRef,
}: {
  /** The conversation the selection lives in — the aside binds to it. */
  sessionId: string
  containerRef: React.RefObject<HTMLElement | null>
}) {
  const t = useTranslations("chat.selection")
  const anchor = useTranscriptSelection(containerRef)
  const busyRef = useRef(false)

  const onAsk = useCallback(async () => {
    if (!anchor || busyRef.current) return
    busyRef.current = true
    try {
      const binding: SessionSurfaceBinding = { kind: "session", sessionId }
      const aside = await createResourceWorkbenchSession(binding, asideTitleFor(anchor.text))
      // Point the dock at the new aside…
      useContextWorkbenchStore
        .getState()
        .setSessionOverride(
          getContextResourceKey({ kind: "session", capabilities: ["ai"], sessionId }),
          aside.id
        )
      // …and seed its composer with the quote, cursor after it. Not auto-sent:
      // the selection is the subject, not the question.
      dispatchComposerAppend({
        text: `${anchor.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`,
        sessionId: aside.id,
      })
      window.getSelection()?.removeAllRanges()
    } catch (err) {
      log.error("selection-aside-failed", { sessionId, error: String(err) })
      toast.error(t("askError"))
    } finally {
      busyRef.current = false
    }
  }, [anchor, sessionId, t])

  if (!anchor) return null

  return (
    <div
      data-testid="message-selection-toolbar"
      className="fixed z-50 -translate-x-full translate-y-1"
      style={{ left: anchor.x, top: anchor.y }}
    >
      <Button
        size="sm"
        variant="secondary"
        className="h-7 gap-1.5 text-xs shadow-md"
        // `onMouseDown` + preventDefault: a plain click would collapse the
        // selection before the handler runs, and the quote would come back empty.
        onMouseDown={(e) => {
          e.preventDefault()
          void onAsk()
        }}
      >
        <MessagesSquareIcon className="size-3.5" />
        {t("askInAside")}
      </Button>
    </div>
  )
}
