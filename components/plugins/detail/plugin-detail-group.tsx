"use client"

// Flat layout primitives for the plugin detail pane.
//
// The pane used to wrap every group in a `Card`. In a right pane that is a
// third of the window, a stack of cards spends most of its width and height on
// borders, radii, and per-card padding, and the nesting reads as depth that
// does not exist: a card inside a collapsible section inside a scroll area.
// These primitives keep the same grouping with a label and a hairline, so the
// content gets the space instead of the chrome.

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

export interface PluginDetailGroupProps {
  title: string
  /** Optional status glyph rendered before the title. */
  icon?: ReactNode
  /** Rendered at the end of the title row (a count, a small action). */
  actions?: ReactNode
  className?: string
  testId?: string
  children: ReactNode
}

export function PluginDetailGroup({
  title,
  icon,
  actions,
  className,
  testId,
  children,
}: PluginDetailGroupProps) {
  return (
    <section
      className={cn("border-t pt-2 first:border-t-0 first:pt-0", className)}
      data-testid={testId}
      data-slot="plugin-detail-group"
    >
      <div className="mb-1.5 flex min-w-0 items-center gap-1.5">
        {icon}
        <h3 className="truncate text-xs font-semibold text-muted-foreground">{title}</h3>
        {actions ? <div className="ml-auto shrink-0">{actions}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

/** Dense label/value list. One row per fact, no box around it. */
export function PluginMetaList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <dl className={cn("grid grid-cols-1 gap-y-1", className)} data-slot="plugin-meta-list">
      {children}
    </dl>
  )
}

export interface PluginMetaRowProps {
  label: string
  value: string
  /** Ids, versions, URLs and timestamps read better in the mono face. */
  mono?: boolean
}

export function PluginMetaRow({ label, value, mono }: PluginMetaRowProps) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-xs">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 flex-1 text-right break-all text-foreground",
          mono && "font-mono text-[11px]"
        )}
      >
        {value}
      </dd>
    </div>
  )
}

/**
 * The pane's "there is nothing here" answer.
 *
 * Distinct from a disabled control or an empty JSON dump: a plugin that
 * declares no settings must say so, because rendering `{}` in an uneditable
 * code block reads as a broken editor rather than as an absence.
 */
export function PluginDetailNone({
  message,
  hint,
  testId,
}: {
  message: string
  hint?: string
  testId?: string
}) {
  return (
    <div
      className="rounded-control border border-dashed px-3 py-4 text-center"
      data-testid={testId}
      data-slot="plugin-detail-none"
    >
      <p className="text-xs text-muted-foreground">{message}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground/80">{hint}</p> : null}
    </div>
  )
}
