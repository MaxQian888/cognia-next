"use client"

/**
 * The jump strip under the device masthead.
 *
 * The dashboard dropped its five tabs on purpose: as one scroll, nothing is
 * behind a click and the reader can see how much there is. What that cost was
 * orientation. A paired phone runs to eleven cards, and the only way to find
 * "Access" was to scroll for it, then scroll back up to find out which device
 * you were on. This keeps the one scroll and adds a table of contents: every
 * card that rendered is a chip, the one in view is marked, and a tap jumps.
 *
 * The chips come from `planDeviceSections`, the same plan the grid is laid out
 * from, so a chip can never point at a card that did not render. The strip
 * scrolls sideways rather than wrapping: on a narrow pane or a phone two rows
 * of chips would be more chrome than the masthead they sit under.
 *
 * A sideways scroll with a hidden scrollbar is invisible, though: the last
 * chip was simply cut at the pane edge, and nothing said there were four more.
 * So an edge that has more chips beyond it fades out, and only that edge.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

/** Which ends of the strip have chips scrolled out of view beyond them. */
interface OverflowEdges {
  start: boolean
  end: boolean
}

/** Fade only the edges that hide something. Literal classes for Tailwind's scanner. */
const EDGE_MASK: Record<"none" | "start" | "end" | "both", string> = {
  none: "",
  start: "[mask-image:linear-gradient(to_right,transparent,black_1.5rem)]",
  end: "[mask-image:linear-gradient(to_left,transparent,black_1.5rem)]",
  both: "[mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)]",
}

export function overflowEdges(el: {
  scrollLeft: number
  scrollWidth: number
  clientWidth: number
}): OverflowEdges {
  // One pixel of slack: subpixel layout can leave `scrollLeft` a fraction shy
  // of the end, which would keep a fade over a chip that is fully visible.
  return {
    start: el.scrollLeft > 1,
    end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
  }
}

export interface DeviceSectionNavItem {
  /** The section's DOM id, `device-section-<id>`. */
  anchor: string
  label: string
}

export interface DeviceSectionNavProps {
  items: readonly DeviceSectionNavItem[]
  activeAnchor: string | null
  onJump: (anchor: string) => void
  className?: string
}

export function DeviceSectionNav({
  items,
  activeAnchor,
  onJump,
  className,
}: DeviceSectionNavProps) {
  const t = useTranslations("devices.detail")
  const strip = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<OverflowEdges>({ start: false, end: false })

  // Re-measured on scroll and whenever the strip or its chips change size (a
  // dragged pane divider, a different device's chip set). The first reading
  // waits a frame so it is taken after layout, not during the commit.
  useEffect(() => {
    const container = strip.current
    if (!container) return
    const measure = () => {
      const next = overflowEdges(container)
      setEdges((previous) =>
        previous.start === next.start && previous.end === next.end ? previous : next
      )
    }
    const frame = requestAnimationFrame(measure)
    container.addEventListener("scroll", measure, { passive: true })
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
    observer?.observe(container)
    for (const chip of Array.from(container.children)) observer?.observe(chip)
    return () => {
      cancelAnimationFrame(frame)
      container.removeEventListener("scroll", measure)
      observer?.disconnect()
    }
  }, [items])

  // Keep the marked chip in view as the reader scrolls the pane. Horizontal
  // only, via `scrollLeft`, so the page and the drawer around it never move.
  useEffect(() => {
    const container = strip.current
    if (!container || !activeAnchor) return
    const chip = container.querySelector<HTMLElement>(`[data-anchor="${activeAnchor}"]`)
    if (!chip) return
    const left = chip.offsetLeft
    const right = left + chip.offsetWidth
    if (left < container.scrollLeft) container.scrollLeft = left - 8
    else if (right > container.scrollLeft + container.clientWidth) {
      container.scrollLeft = right - container.clientWidth + 8
    }
  }, [activeAnchor])

  // One card is not a dashboard worth navigating.
  if (items.length < 2) return null

  return (
    <nav aria-label={t("sectionNavAria")} className={className} data-testid="device-section-nav">
      <div
        ref={strip}
        className={cn(
          "-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          EDGE_MASK[
            edges.start && edges.end ? "both" : edges.start ? "start" : edges.end ? "end" : "none"
          ]
        )}
        data-overflow-start={edges.start || undefined}
        data-overflow-end={edges.end || undefined}
      >
        {items.map((item) => {
          const active = item.anchor === activeAnchor
          return (
            <button
              key={item.anchor}
              type="button"
              data-anchor={item.anchor}
              aria-current={active ? "location" : undefined}
              onClick={() => onJump(item.anchor)}
              className={cn(
                "shrink-0 rounded-pill px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
              data-testid={`device-section-nav-${item.anchor}`}
            >
              {item.label}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
