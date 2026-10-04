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
 * scrolls sideways rather than wrapping: on a narrow pane or a phone drawer
 * two rows of chips would be more chrome than the masthead they sit under.
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"

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
        className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
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
                "shrink-0 rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors",
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
