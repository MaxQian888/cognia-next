"use client"

import type { ComponentProps } from "react"

import type { PopoverContent } from "@/components/ui/popover"
import { useIsMobile } from "@/hooks/ui/use-mobile"

type PopoverContentProps = ComponentProps<typeof PopoverContent>

/** The geometry a nested composer flyout hands its `PopoverContent`. */
export interface FlyoutPlacement {
  side: NonNullable<PopoverContentProps["side"]>
  align: NonNullable<PopoverContentProps["align"]>
  sideOffset: number
  collisionPadding: number
  /** Width clamp so the panel can never be wider than the viewport it sits in. */
  className: string
}

/**
 * Where a second-level panel opened from a row of the composer's `+` menu
 * (the skill list, the web-search setup card) goes.
 *
 * On a wide screen it flies out to the right of the row, the desktop menu
 * idiom. On a phone there is no "right of the row": the parent panel already
 * spans most of the width, and Radix only flips a placement to the OPPOSITE
 * side, so when neither side can hold a 16-18rem panel it stays on the right
 * and runs off the screen edge (the Web card was entirely off-screen). Below
 * the mobile breakpoint the flyout stacks above its row instead, centred and
 * held inside the viewport by the collision padding, which is an axis the
 * screen always has room on.
 */
export function resolveFlyoutPlacement(narrow: boolean): FlyoutPlacement {
  return narrow
    ? {
        side: "top",
        align: "center",
        sideOffset: 8,
        collisionPadding: 8,
        className: "max-w-[calc(100vw-1rem)]",
      }
    : {
        side: "right",
        align: "start",
        sideOffset: 8,
        collisionPadding: 8,
        className: "max-w-[calc(100vw-1rem)]",
      }
}

/** {@link resolveFlyoutPlacement} for the current viewport. */
export function useFlyoutPlacement(): FlyoutPlacement {
  return resolveFlyoutPlacement(useIsMobile())
}
