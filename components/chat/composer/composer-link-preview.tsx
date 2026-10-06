"use client"

/**
 * Link preview over the composer's folded links (ADR-0218).
 *
 * The composer is a `<textarea>` under a painted overlay, and the overlay
 * takes no pointer events (`composer-chip-overlay.tsx`), so a link label is
 * never a hover target in the DOM. This component finds it instead:
 *
 *   - **pointer devices:** pointer moves over the textarea are hit-tested
 *     against the overlay's `[data-chip="link"]` line boxes; resting on one
 *     opens the card after the same delay as a message link;
 *   - **touch:** a tap that leaves the caret inside a folded label opens the
 *     card (tapping a label is the only way the caret lands inside one, since
 *     the composer folds a URL as soon as the caret leaves it).
 *
 * The card is anchored on the label's line box through a virtual anchor and
 * never takes focus: the textarea keeps the caret and the keyboard, and typing
 * closes the card.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react"
import { LinkPreviewCard } from "@/components/chat/link-preview/link-preview-card"
import {
  LINK_PREVIEW_CLOSE_DELAY_MS,
  LINK_PREVIEW_OPEN_DELAY_MS,
} from "@/components/chat/link-preview/link-hover-preview"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useLinkPreview } from "@/hooks/chat/use-link-preview"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"

export interface ComposerLinkPreviewProps {
  textareaRef: RefObject<HTMLTextAreaElement | null>
  chipOverlayRef: RefObject<HTMLDivElement | null>
  /** Touch input opens on caret placement instead of hover. */
  touchInput: boolean
}

interface LinkHit {
  url: string
  rect: DOMRect
}

function linkUrl(el: HTMLElement): string | null {
  const url = el.dataset.linkUrl ?? el.textContent ?? ""
  return /^https?:\/\//i.test(url) ? url : null
}

/** The folded link under a viewport point, with the line box it sits in. */
export function hitTestLink(overlay: HTMLElement, x: number, y: number): LinkHit | null {
  for (const el of overlay.querySelectorAll<HTMLElement>('[data-chip="link"]')) {
    for (const rect of Array.from(el.getClientRects())) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        const url = linkUrl(el)
        return url ? { url, rect } : null
      }
    }
  }
  return null
}

/** The folded link containing text offset `caret`, anchored on its first line box. */
export function linkAtCaret(overlay: HTMLElement, caret: number): LinkHit | null {
  for (const el of overlay.querySelectorAll<HTMLElement>('[data-chip="link"]')) {
    const start = Number(el.dataset.linkStart)
    const end = Number(el.dataset.linkEnd)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    // Strictly inside: a caret parked right after a label is the user typing
    // on, not pointing at the link.
    if (caret > start && caret < end) {
      const url = linkUrl(el)
      const rect = el.getClientRects()[0] ?? el.getBoundingClientRect()
      return url ? { url, rect } : null
    }
  }
  return null
}

export function ComposerLinkPreview({
  textareaRef,
  chipOverlayRef,
  touchInput,
}: ComposerLinkPreviewProps) {
  const enabled = useMessageDisplay().links.preview !== "off"
  const [hit, setHit] = useState<LinkHit | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pending = useRef<string | null>(null)
  const state = useLinkPreview(hit?.url ?? null, hit !== null)

  const clearTimers = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }, [])

  const close = useCallback(() => {
    clearTimers()
    pending.current = null
    setHit(null)
  }, [clearTimers])

  const scheduleClose = useCallback(() => {
    if (openTimer.current) clearTimeout(openTimer.current)
    openTimer.current = null
    pending.current = null
    if (closeTimer.current) return
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setHit(null)
    }, LINK_PREVIEW_CLOSE_DELAY_MS)
  }, [])

  // Pointer devices: hover.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!enabled || touchInput || !textarea) return
    const onMove = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" && event.pointerType !== "pen") return
      const overlay = chipOverlayRef.current
      const next = overlay ? hitTestLink(overlay, event.clientX, event.clientY) : null
      if (!next) {
        scheduleClose()
        return
      }
      if (closeTimer.current) clearTimeout(closeTimer.current)
      closeTimer.current = null
      if (hit?.url === next.url || pending.current === next.url) return
      if (openTimer.current) clearTimeout(openTimer.current)
      pending.current = next.url
      openTimer.current = setTimeout(() => {
        openTimer.current = null
        pending.current = null
        setHit(next)
      }, LINK_PREVIEW_OPEN_DELAY_MS)
    }
    textarea.addEventListener("pointermove", onMove)
    textarea.addEventListener("pointerleave", scheduleClose)
    return () => {
      textarea.removeEventListener("pointermove", onMove)
      textarea.removeEventListener("pointerleave", scheduleClose)
    }
  }, [enabled, touchInput, textareaRef, chipOverlayRef, hit, scheduleClose])

  // Touch: caret placed inside a folded label.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!enabled || !touchInput || !textarea) return
    const onSelectionChange = () => {
      if (document.activeElement !== textarea) return
      const start = textarea.selectionStart ?? 0
      if (start !== (textarea.selectionEnd ?? start)) return
      const overlay = chipOverlayRef.current
      const next = overlay ? linkAtCaret(overlay, start) : null
      setHit((current) => (next ? (current?.url === next.url ? current : next) : null))
    }
    document.addEventListener("selectionchange", onSelectionChange)
    return () => document.removeEventListener("selectionchange", onSelectionChange)
  }, [enabled, touchInput, textareaRef, chipOverlayRef])

  // Typing, scrolling or leaving the box invalidates the anchor.
  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.addEventListener("input", close)
    textarea.addEventListener("scroll", close)
    textarea.addEventListener("blur", close)
    return () => {
      textarea.removeEventListener("input", close)
      textarea.removeEventListener("scroll", close)
      textarea.removeEventListener("blur", close)
    }
  }, [textareaRef, close])

  useEffect(() => clearTimers, [clearTimers])

  // One stable virtual element per hit, so Radix does not re-measure on
  // every render.
  const anchor = useMemo(
    () => ({ current: { getBoundingClientRect: () => hit?.rect ?? new DOMRect() } }),
    [hit]
  )

  if (!enabled || !hit) return null
  return (
    <Popover open onOpenChange={(open) => (open ? undefined : close())}>
      <PopoverAnchor virtualRef={anchor} />
      <PopoverContent
        side="top"
        align="start"
        className="w-auto overflow-hidden p-0"
        data-testid="composer-link-preview"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={() => {
          if (closeTimer.current) clearTimeout(closeTimer.current)
          closeTimer.current = null
        }}
        onPointerLeave={touchInput ? undefined : scheduleClose}
      >
        <LinkPreviewCard url={hit.url} state={state} allowFetch />
      </PopoverContent>
    </Popover>
  )
}
