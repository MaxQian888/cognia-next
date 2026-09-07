"use client"

/**
 * Section wrapper for the mobile profile screen.
 *
 * Renders a small-caps heading on top of an `<ItemGroup>` (the existing
 * shadcn list primitive from `components/ui/item.tsx`). The point of this
 * wrapper is purely to give every /me section the same visual rhythm —
 * the underlying group + separators are reused from `ui/item.tsx` so the
 * row treatment stays consistent with Discover and the connection sheets.
 */

import * as React from "react"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { ItemGroup, ItemSeparator } from "@/components/ui/item"
import { Surface } from "@/components/surface/surface"

export interface MeSectionProps {
  title: string
  description?: string
  className?: string
  children: React.ReactNode
  /**
   * When true, an `<ItemSeparator>` is inserted between adjacent
   * children. Off by default — many sections already use `Item` rows
   * whose own border + bg gives enough visual structure.
   */
  withSeparators?: boolean
  /**
   * Pass a `data-testid` to make the section addressable in tests.
   */
  testid?: string
  /**
   * Right-aligned slot on the heading line. Use it for a status badge or a
   * compact icon button that belongs to this section.
   *
   * Without it, a section-level control had to live inside the group as a
   * full-width or `self-start` button, which is how `/me/storage` ended up
   * showing two identical "Refresh" buttons stacked in the reading flow.
   */
  action?: ReactNode
}

export function MeSection({
  title,
  description,
  className,
  children,
  withSeparators = false,
  testid,
  action,
}: MeSectionProps) {
  const items = React.Children.toArray(children).filter(Boolean)
  return (
    <section className={cn("flex flex-col gap-2", className)} data-testid={testid}>
      <div className="flex items-start justify-between gap-2 px-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {title}
          </h2>
          {description ? (
            <p className="text-[11px] text-muted-foreground/80">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-1.5">{action}</div> : null}
      </div>
      {/* `Surface` rather than `bg-card rounded-xl`: this group is every row
          block on all 48 `/me` pages, so it is the single largest thing a
          style pack could not reach on a phone. `raised` is the tier a card
          sits at, and `panel` is the named radius step that tracks `--radius`
          instead of pinning 12px. The border stays a class because a tier
          implies a background, not a stroke. */}
      {/* No children, no surface. A section whose rows are all conditional
          (the auto-backup interval, for one) otherwise painted an empty
          bordered box two pixels tall under its own heading. */}
      {items.length > 0 ? (
        <Surface
          asChild
          layer="raised"
          radius="panel"
          className="overflow-hidden border"
          aria-label={title}
        >
          <ItemGroup>
            {withSeparators
              ? items.map((child, idx) => (
                  <React.Fragment key={(child as React.ReactElement).key ?? idx}>
                    {idx > 0 ? <ItemSeparator /> : null}
                    {child}
                  </React.Fragment>
                ))
              : items}
          </ItemGroup>
        </Surface>
      ) : null}
    </section>
  )
}
