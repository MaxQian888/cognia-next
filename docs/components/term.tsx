"use client"

import { useState, useId, type ReactNode } from "react"

type Props = {
  /** Definition shown when the user hovers / focuses the term. */
  def: string
  /** Optional anchor link to the canonical definition page. */
  href?: string
  children: ReactNode
}

/**
 * Glossary term — underlines the wrapped text and shows `def` in a tooltip
 * on hover or keyboard focus. Falls back gracefully without JS (the
 * underline + title attribute still convey the definition).
 */
export function Term({ def, href, children }: Props) {
  const [open, setOpen] = useState(false)
  const tipId = useId()

  const content = (
    <span
      className="relative cursor-help border-b border-dotted border-fd-muted-foreground/60 hover:border-fd-foreground"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      tabIndex={0}
      aria-describedby={tipId}
      title={def}
    >
      {children}
      {open ? (
        <span
          id={tipId}
          role="tooltip"
          className="absolute left-1/2 top-full z-30 mt-1.5 w-64 -translate-x-1/2 rounded-md border border-fd-border bg-fd-popover px-3 py-2 text-xs text-fd-popover-foreground shadow-lg"
        >
          {def}
        </span>
      ) : null}
    </span>
  )

  if (!href) return content

  return (
    <a href={href} className="text-fd-foreground no-underline hover:text-fd-accent-foreground">
      {content}
    </a>
  )
}
