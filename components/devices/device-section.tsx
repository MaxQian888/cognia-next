"use client"

/**
 * One card in the device dashboard.
 *
 * The detail pane used to be five tabs, which made the reader pay for every
 * question with a click and hid the fact that most of the answers are two
 * lines long. As one scrolling surface the sections have to look like
 * siblings, and that is only true if a single component owns the frame,
 * heading and padding — six hand-built headers drift within a week.
 *
 * `wide` is the layout hint rather than a class, so a section declares "I
 * hold a matrix" and the grid decides what that means at the current pane
 * width. Callers passing `col-span-*` themselves is how a grid ends up with
 * one card that never lines up.
 */

import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"

export interface DeviceSectionProps {
  /** Anchor id, also the `data-testid` suffix. */
  id: string
  title: string
  icon?: LucideIcon
  /** Right-aligned counter or status, kept to a few characters. */
  meta?: React.ReactNode
  /** One line under the title, for a section whose scope is not obvious. */
  description?: string
  /** Spans the full grid width — for matrices and lists, not fact pairs. */
  wide?: boolean
  children: React.ReactNode
  className?: string
}

export function DeviceSection({
  id,
  title,
  icon: Icon,
  meta,
  description,
  wide,
  children,
  className,
}: DeviceSectionProps) {
  return (
    <section
      id={`device-section-${id}`}
      data-testid={`device-section-${id}`}
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card shadow-sm",
        // `@container` sections are laid out by the pane grid; a wide one
        // opts out of the column split rather than choosing a span number.
        wide && "@3xl/device-pane:col-span-2",
        className
      )}
    >
      <header className="flex items-baseline gap-2 border-b px-3.5 py-2.5">
        {Icon ? (
          <Icon className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[13px] font-semibold leading-tight">{title}</h3>
          {description ? (
            <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {meta ? (
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{meta}</span>
        ) : null}
      </header>
      {/* The card, not the pane, is the container for its own contents. A
          half-width card and a full-width one sit in the same pane, so
          sizing off the pane gives both the same column count — which is how
          a two-column fact list ends up crammed into a 300px card. */}
      <div className="@container/device-card min-w-0 flex-1 px-3.5 py-3">{children}</div>
    </section>
  )
}
