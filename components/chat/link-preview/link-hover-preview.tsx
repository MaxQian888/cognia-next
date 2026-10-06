"use client"

/**
 * Wraps an external link so it shows {@link LinkPreviewCard} (ADR-0218).
 *
 * A pointer that can hover opens it after a short delay through a Radix
 * HoverCard, following `session-environment-chip.tsx`. A touch device cannot
 * hover and a tap must still follow the link, so there the card opens on a
 * long press instead, through a Popover anchored on the link, and the click
 * that ends the press is swallowed.
 *
 * The preview is only requested while the card is open, so rendering a
 * message with fifty links costs nothing until someone looks at one.
 */

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { useLinkPreview } from "@/hooks/chat/use-link-preview"
import { useHasHover } from "@/hooks/ui/use-pointer"
import { LinkPreviewCard } from "./link-preview-card"

export const LINK_PREVIEW_OPEN_DELAY_MS = 450
export const LINK_PREVIEW_CLOSE_DELAY_MS = 150
export const LINK_PREVIEW_LONG_PRESS_MS = 500
/** A press that drifts further than this is a scroll, not a long press. */
const LONG_PRESS_SLOP_PX = 10

export interface LinkHoverPreviewProps {
  url: string
  /** Whether the page and its images may be requested (off while streaming). */
  allowFetch: boolean
  /** The link element; it must forward refs and DOM handlers (an `<a>` does). */
  children: ReactElement
}

const CARD_CLASS = "w-auto overflow-hidden p-0"

export function LinkHoverPreview({ url, allowFetch, children }: LinkHoverPreviewProps) {
  const hasHover = useHasHover()
  const [open, setOpen] = useState(false)
  const state = useLinkPreview(url, open && allowFetch)
  const card = <LinkPreviewCard url={url} state={state} allowFetch={allowFetch} />

  if (hasHover) {
    return (
      <HoverCard
        open={open}
        onOpenChange={setOpen}
        openDelay={LINK_PREVIEW_OPEN_DELAY_MS}
        closeDelay={LINK_PREVIEW_CLOSE_DELAY_MS}
      >
        <HoverCardTrigger asChild>{children}</HoverCardTrigger>
        <HoverCardContent align="start" className={CARD_CLASS}>
          {card}
        </HoverCardContent>
      </HoverCard>
    )
  }

  return (
    <TouchLinkPreview open={open} onOpenChange={setOpen} card={card}>
      {children}
    </TouchLinkPreview>
  )
}

function TouchLinkPreview({
  open,
  onOpenChange,
  card,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  card: ReactElement
  children: ReactElement
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const swallowClick = useRef(false)

  const cancel = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    start.current = null
  }, [])

  useEffect(() => cancel, [cancel])

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span
          className="[-webkit-touch-callout:none]"
          data-link-preview-anchor
          onPointerDown={(event) => {
            if (event.pointerType === "mouse") return
            cancel()
            start.current = { x: event.clientX, y: event.clientY }
            timer.current = setTimeout(() => {
              timer.current = null
              swallowClick.current = true
              onOpenChange(true)
            }, LINK_PREVIEW_LONG_PRESS_MS)
          }}
          onPointerMove={(event) => {
            const origin = start.current
            if (!origin) return
            if (
              Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > LONG_PRESS_SLOP_PX
            ) {
              cancel()
            }
          }}
          onPointerUp={cancel}
          onPointerCancel={cancel}
          onContextMenu={(event) => {
            // The OS link menu would cover the card the long press just opened.
            if (swallowClick.current || open) event.preventDefault()
          }}
          onClickCapture={(event) => {
            if (!swallowClick.current) return
            swallowClick.current = false
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          {children}
        </span>
      </PopoverAnchor>
      <PopoverContent align="start" className={CARD_CLASS}>
        {card}
      </PopoverContent>
    </Popover>
  )
}
