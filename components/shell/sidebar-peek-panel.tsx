"use client"

/**
 * The collapsed sidebar's edge peek: a hover strip pinned to the seam the rail
 * folded into, and the flyout that slides out of it.
 *
 * Both pieces are children of the collapsed `<aside>` itself, which is the
 * whole trick. That element keeps its place in the shell's flex row while
 * collapsed (zero wide, full height, in the correct column on the correct
 * edge), so an absolutely positioned child of it lands exactly where the rail
 * used to be with no measurement, no portal and no viewport math that a
 * resized window or a newly shown status bar could invalidate.
 *
 * What the flyout shows is the list in its unmerged form: a title row, the
 * search field, the conversations and the guild rows. That is deliberate and it
 * is not the expanded rail. A collapsed sidebar hands the shell navigation back
 * to the 56px icon column, which is on screen the whole time the peek is, so a
 * flyout that repeated the nav rows and the account card would be a second copy
 * of a column the user is already looking at.
 *
 * The flyout stays mounted while the rail is collapsed and animates its
 * transform rather than mounting on hover. That is what makes the motion
 * reversible: a pointer that brushes the strip and leaves mid-slide reverses
 * from wherever it got to instead of snapping. The list inside it is the same
 * single instance the expanded rail renders, moved by a class rather than
 * rebuilt, so peeking costs no re-render of the conversation model.
 */

import { useTranslations } from "next-intl"
import { ChevronLeftIcon, ChevronRightIcon, PinIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Surface } from "@/components/surface/surface"
import { SHELL_DOCK_TIMING_CLASS } from "@/lib/ui/shell-dock-motion"
import { cn } from "@/lib/utils"
import type { SidebarSide } from "@/types/shell/sidebar"

/** Width of the invisible hover target, in px. Wide enough to hit, narrow enough to cross. */
export const SIDEBAR_PEEK_STRIP_PX = 12

/**
 * Slack the clip window keeps past the panel so the elevation is not sheared
 * off at the edge the panel slides toward.
 */
export const PEEK_SHADOW_ROOM_PX = 24

export interface SidebarPeekEdgeProps {
  /** Which window edge the collapsed rail folded into. */
  side: SidebarSide
  /** Dimmed until hovered, then a hairline that says the rail is still there. */
  active: boolean
  onMouseEnter: () => void
  onMouseLeave: () => void
}

/**
 * The hover target. Decorative for assistive tech: it opens a panel that is
 * already reachable by the toggle and its shortcut, so announcing a nameless
 * hover strip would only add noise to the rail's own landmark.
 */
export function SidebarPeekEdge({
  side,
  active,
  onMouseEnter,
  onMouseLeave,
}: SidebarPeekEdgeProps) {
  return (
    <div
      aria-hidden
      data-testid="sidebar-peek-edge"
      data-side={side}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{ width: SIDEBAR_PEEK_STRIP_PX }}
      className={cn(
        "group absolute inset-y-0 z-30 flex items-center justify-center",
        side === "right" ? "right-0" : "left-0"
      )}
    >
      {/* The affordance. Invisible until the pointer is on the strip or the
          panel is out, because a permanent bar on the seam reads as a border
          that failed to collapse. */}
      <span
        data-testid="sidebar-peek-grip"
        className={cn(
          "h-16 w-[3px] rounded-pill bg-muted-foreground/40 transition-opacity duration-150",
          active ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        )}
      />
    </div>
  )
}

export interface SidebarPeekFrameProps {
  /**
   * The rail is collapsed and the peek is available, so the frame leaves the
   * flex row and becomes the flyout. `false` puts it back in flow as the
   * fixed-width inner layer the expanded rail is built from.
   */
  armed: boolean
  /** The flyout is out. `false` while armed parks it just past the edge. */
  open: boolean
  side: SidebarSide
  width: number
  /** Restore the rail for good, from inside the flyout. */
  onPin: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  children: React.ReactNode
}

export function SidebarPeekFrame({
  armed,
  open,
  side,
  width,
  onPin,
  onMouseEnter,
  onMouseLeave,
  children,
}: SidebarPeekFrameProps) {
  const t = useTranslations("desktop.channelList")
  const onRight = side === "right"

  return (
    // ONE tree, two presentations. Never an early return with a different
    // shape: `children` is the whole conversation list, and React reconciles by
    // position, so an element type that changed when `armed` flips would
    // UNMOUNT the list on every collapse and expand, losing the search query,
    // the scroll offset and every live query it had open. Arming a peek must
    // cost a repaint, not a remount, so both modes keep the same two elements
    // and differ only in what is set on them.
    //
    // Armed, this is the clip window. A parked flyout is a whole 260px panel
    // sitting just past the seam, which on the left edge means it lands
    // squarely on top of the 56px icon column. Clipping it here rather than
    // fading it out is what lets the slide stay fully opaque in both
    // directions: a translucent rail over the message list is unreadable, and
    // half of one mid-slide is worse. The window is wider and taller than the
    // panel so the elevation is not sheared off along with it, and it passes
    // every pointer straight through. Unarmed, it is the fixed-width box that
    // keeps the list from reflowing as the aside's width animates to 0.
    <div
      aria-hidden={armed ? !open || undefined : undefined}
      style={{ width: armed ? width + PEEK_SHADOW_ROOM_PX : width }}
      className={
        armed
          ? cn(
              "pointer-events-none absolute -inset-y-2 z-40 overflow-hidden",
              onRight ? "right-0" : "left-0"
            )
          : "flex h-full min-h-0 flex-col"
      }
    >
      {/* `overlay` is the tier this belongs to (ADR-0148): it floats over the
          message list exactly like a popover or a sheet, and reading it needs a
          ground the wallpaper does not show through. Elevation rather than a
          shadow utility, so a style pack that flattens the app flattens this
          too. */}
      <Surface
        // Unarmed, every surface attribute is CLEARED rather than merely
        // restyled. `Surface` spreads its own props last, so passing these
        // explicitly wins over `layer` and `elevation`, and that matters:
        // `globals.css` hangs the wallpaper's backdrop blur off the bare
        // `[data-surface-layer]` selector, so leaving the attribute on an
        // in-flow rail layer would promote a compositing layer under every
        // wallpaper. The element stays put either way, which is the point.
        layer="overlay"
        radius={armed ? "panel" : "inherit"}
        elevation={3}
        data-surface-layer={armed ? "overlay" : undefined}
        data-elevation={armed ? "3" : undefined}
        data-testid={armed ? "sidebar-peek-panel" : undefined}
        data-open={(armed && open) || undefined}
        data-side={armed ? side : undefined}
        style={
          armed
            ? {
                width,
                // Parked past its own width AND past the slack the clip window
                // keeps for the elevation. A plain `-100%` puts the panel's
                // edge exactly on the window's, which clips the panel but
                // leaves its shadow spilling into the slack as a permanent
                // smudge on the seam.
                transform: open
                  ? "translateX(0)"
                  : `translateX(calc(${onRight ? "" : "-"}100% ${onRight ? "+" : "-"} ${PEEK_SHADOW_ROOM_PX}px))`,
              }
            : undefined
        }
        // Closed, the panel is off screen and must not be tabbed into or read.
        inert={(armed && !open) || undefined}
        onMouseEnter={armed ? onMouseEnter : undefined}
        onMouseLeave={armed ? onMouseLeave : undefined}
        className={
          armed
            ? cn(
                "pointer-events-auto absolute inset-y-3 flex min-h-0 flex-col overflow-hidden border border-border/70",
                `transition-transform ${SHELL_DOCK_TIMING_CLASS}`,
                onRight ? "right-0" : "left-0"
              )
            : // No tint of its own in flow: the rail's ground is the aside's,
              // and `ChannelListBody` owns the tint over it.
              "flex min-h-0 flex-1 flex-col bg-transparent"
        }
      >
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {/* The frame's own strip, not a control floated over the list. A peek
            is a borrowed surface and the borrower needs one thing the rail
            itself cannot offer while collapsed: the way to stop borrowing.
            Floating it over the corner put it straight on top of the list
            header's own actions, which are 40px away and do something else. */}
        {armed ? (
          <div
            className={cn(
              "flex shrink-0 items-center gap-2 border-t px-2 py-1",
              onRight ? "flex-row-reverse" : "flex-row"
            )}
          >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={onPin}
              data-testid="sidebar-peek-pin"
              className="h-6 gap-1.5 px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            >
              <PinIcon className="size-3" aria-hidden />
              {t("pinSidebar")}
            </Button>
            {/* Which way it folds back, on the seam it folds into. */}
            <span aria-hidden className="text-muted-foreground/40">
              {onRight ? (
                <ChevronRightIcon className="size-3" />
              ) : (
                <ChevronLeftIcon className="size-3" />
              )}
            </span>
          </div>
        ) : null}
      </Surface>
    </div>
  )
}
