"use client"

/**
 * One card in a console dashboard.
 *
 * Lifted verbatim from `components/devices/device-section.tsx`, which wrote
 * down the reasoning: a detail pane that used to be five tabs made the reader
 * pay for every question with a click, and as one scrolling surface the
 * sections only read as siblings if a single component owns the frame, heading
 * and padding. Six hand-built headers drift within a week.
 *
 * It is here rather than under `components/devices/` because nothing in it was
 * ever device-specific, and `/workspace` was hand-rolling the same card out of
 * bare `<section>` elements. `DeviceSection` now forwards to this.
 *
 * `wide` is the layout hint rather than a class, so a section declares "I hold
 * a matrix" and the grid decides what that means at the current pane width.
 * Callers passing `col-span-*` themselves is how a grid ends up with one card
 * that never lines up.
 */

import type { LucideIcon } from "lucide-react"

import { Surface } from "@/components/surface/surface"
import { cn } from "@/lib/utils"

/**
 * Panes that host console sections.
 *
 * Spelled out as a union with literal classes below rather than interpolated,
 * for the same reason `DeviceHero`'s column map is: Tailwind's scanner reads
 * source text, so `@3xl/${name}:col-span-2` emits nothing. Adding a pane is a
 * deliberate two-line edit here, and a typo is a type error rather than a card
 * that silently stops spanning.
 */
export type ConsolePaneName = "console-pane" | "device-pane" | "workspace-pane"

/** `wide` opts out of the column split instead of choosing a span number. */
const WIDE_SPAN: Record<ConsolePaneName, string> = {
  "console-pane": "@3xl/console-pane:col-span-2",
  "device-pane": "@3xl/device-pane:col-span-2",
  "workspace-pane": "@3xl/workspace-pane:col-span-2",
}

/**
 * The card, not the pane, is the container for its own contents. A half-width
 * card and a full-width one sit in the same pane, so sizing off the pane gives
 * both the same column count, which is how a two-column fact list ends up
 * crammed into a 300px card.
 */
const CARD_CONTAINER: Record<ConsolePaneName, string> = {
  "console-pane": "@container/console-card",
  "device-pane": "@container/device-card",
  "workspace-pane": "@container/workspace-card",
}

export interface ConsoleSectionProps {
  /** Anchor id, also the `data-testid` suffix. */
  id: string
  title: string
  icon?: LucideIcon
  /** Right-aligned counter or status, kept to a few characters. */
  meta?: React.ReactNode
  /** One line under the title, for a section whose scope is not obvious. */
  description?: string
  /** Spans the full grid width, for matrices and lists, not fact pairs. */
  wide?: boolean
  /**
   * Which pane grid this section is laid out by. Decides the `wide` span and
   * the inner container name.
   */
  pane?: ConsolePaneName
  /** Anchor / testid prefix. Lets `DeviceSection` keep its existing ids. */
  idPrefix?: string
  children: React.ReactNode
  className?: string
}

export function ConsoleSection({
  id,
  title,
  icon: Icon,
  meta,
  description,
  wide,
  pane = "console-pane",
  idPrefix = "console-section",
  children,
  className,
}: ConsoleSectionProps) {
  return (
    <Surface asChild radius="panel" elevation={1}>
      <section
        id={`${idPrefix}-${id}`}
        data-testid={`${idPrefix}-${id}`}
        className={cn("flex min-w-0 flex-col border", wide && WIDE_SPAN[pane], className)}
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
        <div className={cn("min-w-0 flex-1 px-3.5 py-3", CARD_CONTAINER[pane])}>{children}</div>
      </section>
    </Surface>
  )
}
