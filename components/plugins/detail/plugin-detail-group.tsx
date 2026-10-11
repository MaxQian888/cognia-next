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

import { ExternalLink } from "@/components/shared/external-link"
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

/**
 * Dense label/value list. One row per fact, no box around it.
 *
 * Two aligned columns: labels sized to the longest label, values left-aligned
 * right beside them. The values used to be pushed to the far right edge
 * (`justify-between`), so on a wide pane "Author" and its value sat 600px
 * apart and the eye had to cross the whole pane to pair them.
 */
export function PluginMetaList({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <dl
      className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1", className)}
      data-slot="plugin-meta-list"
    >
      {children}
    </dl>
  )
}

export interface PluginMetaRowProps {
  label: string
  value: string
  /** Ids, versions, URLs and paths read better in the mono face. */
  mono?: boolean
  /** Renders the value as an external link (homepage, repository). */
  href?: string
}

export function PluginMetaRow({ label, value, mono, href }: PluginMetaRowProps) {
  return (
    // `contents`: the row is a grouping for the reader of the source, the two
    // cells belong to the list's grid so every label lines up.
    <div className="contents text-xs">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0 text-xs text-foreground",
          // Ids, URLs and paths have no spaces to break at.
          mono ? "font-mono text-[11px] break-all" : "break-words"
        )}
      >
        {href ? (
          // Opens in the OS browser on Tauri and the in-app sheet on
          // Capacitor; a bare `target="_blank"` does neither.
          <ExternalLink href={href} className="underline-offset-2 hover:underline">
            {value}
          </ExternalLink>
        ) : (
          value
        )}
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
 *
 * Plain muted text, not a dashed box: an absence drawn as a container reads
 * as a drop zone or a slot waiting to be filled.
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
    <div className="px-3 py-4 text-center" data-testid={testId} data-slot="plugin-detail-none">
      <p className="text-xs text-muted-foreground">{message}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground/80">{hint}</p> : null}
    </div>
  )
}
