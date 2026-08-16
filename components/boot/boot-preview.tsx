"use client"

/**
 * The boot screen's right-hand pane: an app-shaped mock that assembles as the
 * boot milestones complete. Each piece of chrome is tied to the milestone
 * that makes it real — the avatar to the account read, the title bar to the
 * preferences, the rail to the interface mount — and flips from a ghosted to
 * a settled look the moment that milestone is done. The content area stays a
 * breathing skeleton throughout: it stands for the conversations that only
 * arrive once the workspace itself is restored, and pretending otherwise
 * would be a lie the user could see through the moment the app painted.
 *
 * Purely decorative (`aria-hidden`); the milestone list on the left carries
 * the same information in words. Motion is opacity/transform transitions
 * staggered by `--boot-i` (see `.boot-preview__block` in globals.css).
 */

import type { CSSProperties } from "react"

import { Skeleton } from "@/components/ui/skeleton"
import type { BootMilestone } from "@/lib/boot/boot-progress"
import { cn } from "@/lib/utils"

export type BootPreviewSettled = Readonly<Record<BootMilestone, boolean>>

// Theme-agnostic "ink": a foreground tint reads as drawn chrome on both the
// light and the dark card, where the accent/border tokens are too close to
// the surface for a settled block to look any different from a ghosted one.
const INK = "bg-foreground/10"
const DOT = cn(INK, "size-2 rounded-full")
const RAIL_ICON = cn(INK, "size-6 rounded-lg")

export interface BootPreviewProps {
  /** Which milestones are done — drives which chrome has settled. */
  settled: BootPreviewSettled
  className?: string
}

/** A single ghost→settled block. `order` staggers its transition. */
function Block({
  settled,
  order,
  className,
}: {
  settled: boolean
  order: number
  className: string
}) {
  return (
    <div
      data-slot="boot-preview-block"
      data-settled={settled ? "true" : "false"}
      className={cn("boot-preview__block", className)}
      style={{ "--boot-i": order } as CSSProperties}
    />
  )
}

export function BootPreview({ settled, className }: BootPreviewProps) {
  return (
    <div
      aria-hidden="true"
      data-slot="boot-preview"
      className={cn(
        "hidden border-l border-border/60 bg-muted/35 p-5 sm:flex sm:flex-col",
        className
      )}
    >
      {/* Window controls — real once preferences (theme, chrome) are applied. */}
      <div className="flex items-center gap-1.5">
        <Block settled={settled.preferences} order={0} className={DOT} />
        <Block settled={settled.preferences} order={1} className={DOT} />
        <Block settled={settled.preferences} order={2} className={DOT} />
      </div>

      <div className="boot-preview__frame mt-5 flex min-h-52 flex-1 gap-3 rounded-xl border border-border/60 bg-background/80 p-3 shadow-sm">
        {/* Rail: the avatar lands with the account read, the icons with the interface. */}
        <div className="w-12 shrink-0 space-y-2 rounded-lg bg-muted/70 p-2">
          <Block
            settled={settled.accounts}
            order={0}
            className={cn(
              "mx-auto size-6 rounded-full border-2",
              settled.accounts ? "border-success/70 bg-success/15" : "border-border bg-muted"
            )}
          />
          <Block settled={settled.interface} order={1} className={RAIL_ICON} />
          <Block settled={settled.interface} order={2} className={RAIL_ICON} />
          <Block settled={settled.interface} order={3} className={RAIL_ICON} />
        </div>

        <div className="min-w-0 flex-1 space-y-3 py-1">
          {/* Title bar / header line — preferences. */}
          <Block
            settled={settled.preferences}
            order={0}
            className={cn(INK, "h-3 w-2/3 rounded-md")}
          />
          {/* Content — still arriving; keeps breathing until the workspace paints. */}
          <Skeleton className="h-16 w-full rounded-lg" />
          <div className="space-y-2">
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2.5 w-4/5" />
            <Skeleton className="h-2.5 w-3/5" />
          </div>
          {/* Composer — exists once the interface is up. */}
          <Block
            settled={settled.interface}
            order={4}
            className="h-8 w-full rounded-lg border border-foreground/10 bg-foreground/[0.04]"
          />
        </div>
      </div>
    </div>
  )
}
