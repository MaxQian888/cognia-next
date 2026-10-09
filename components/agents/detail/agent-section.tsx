"use client"

/**
 * The section frame of an agent's profile (ADR-0220): a small heading with an
 * optional count or note beside it and an optional action at the far end, then
 * the content. No card around it; the profile stacks sections in `divide-y`
 * columns, the way the Squad overview does, so it reads as one page rather
 * than a stack of boxes.
 */

import { cn } from "@/lib/utils"

export function AgentSection({
  id,
  title,
  meta,
  action,
  className,
  children,
}: {
  id: string
  title: string
  meta?: React.ReactNode
  action?: React.ReactNode
  className?: string
  children: React.ReactNode
}) {
  const headingId = `agent-section-${id}-heading`
  return (
    <section
      aria-labelledby={headingId}
      className={cn("py-6 first:pt-0 last:pb-0", className)}
      data-testid={`agent-section-${id}`}
    >
      <header className="mb-3 flex min-h-7 items-center gap-2">
        <h3 id={headingId} className="text-sm font-semibold leading-tight">
          {title}
        </h3>
        {meta ? <span className="text-xs text-muted-foreground">{meta}</span> : null}
        {action ? <div className="ml-auto shrink-0">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

/** One "label: value" row of a facts list (`<dl>`). */
export function AgentFactRow({
  label,
  children,
  mono,
  wrap,
}: {
  label: string
  children: React.ReactNode
  mono?: boolean
  /** Let the value wrap (a run of chips) instead of truncating to one line. */
  wrap?: boolean
}) {
  return (
    <div className="flex items-baseline gap-4 py-1.5 text-[13px]">
      <dt className="w-24 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 flex-1", wrap ? "break-words" : "truncate", mono && "font-mono")}>
        {children}
      </dd>
    </div>
  )
}

/** A muted one-liner for a section with nothing in it. */
export function AgentSectionEmpty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>
}
