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
}

export function MeSection({
  title,
  description,
  className,
  children,
  withSeparators = false,
  testid,
}: MeSectionProps) {
  const items = React.Children.toArray(children).filter(Boolean)
  return (
    <section className={cn("flex flex-col gap-2", className)} data-testid={testid}>
      <div className="flex flex-col gap-0.5 px-1">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
        {description ? <p className="text-[11px] text-muted-foreground/80">{description}</p> : null}
      </div>
      {/* `Surface` rather than `bg-card rounded-xl`: this group is every row
          block on all 48 `/me` pages, so it is the single largest thing a
          style pack could not reach on a phone. `raised` is the tier a card
          sits at, and `panel` is the named radius step that tracks `--radius`
          instead of pinning 12px. The border stays a class because a tier
          implies a background, not a stroke. */}
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
    </section>
  )
}
