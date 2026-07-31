"use client"

import { useSectionProgress } from "@web/hooks/use-section-progress"
import { cn } from "@web/lib/utils"

interface SectionIndexRailProps {
  /** Section ids, in document order. Must match the ids the page renders. */
  sections: readonly string[]
  /** Short label per section id. */
  labels: Record<string, string>
  /** Accessible name for the landmark. */
  label: string
}

/**
 * A reading position indicator for the homepage (ADR-0092 §6).
 *
 * Not a motion vocabulary — it is state made visible. The homepage is 9,000px
 * of eight sections with no chrome between them, and a reader partway down has
 * no way to tell how much argument is left or to jump back to a section they
 * skimmed.
 *
 * Shown only once the viewport is genuinely wider than the content beside it.
 * The shell is `--spacing-shell` (1480px), so on a 1440px laptop the page
 * already fills the window edge to edge and a fixed rail lands *on top of* the
 * hero rather than beside it. The gate is therefore a hard pixel minimum —
 * 1480 of shell plus the rail and its gutter — and not a named breakpoint:
 * `xl` (1280px) and even `2xl` (1536px) are both still too narrow. Below it the
 * rail simply does not exist, which is also the spec's mobile rule: one primary
 * visual per screen.
 *
 * Anchor links rather than scroll handlers: `globals.css` already sets
 * `scroll-behavior: smooth` and already switches it to `auto` under
 * `prefers-reduced-motion`, so the reduced case needs no branch here.
 */
export function SectionIndexRail({ sections, labels, label }: SectionIndexRailProps) {
  const active = useSectionProgress({ sections })

  return (
    <nav
      aria-label={label}
      className="pointer-events-none fixed right-6 top-1/2 z-40 hidden -translate-y-1/2 min-[1760px]:block"
    >
      <ul className="flex flex-col gap-3">
        {sections.map((id) => {
          const current = id === active
          return (
            <li key={id}>
              <a
                href={`#${id}`}
                // `aria-current="location"` is the right token for "this is the
                // part of the page you are in", as opposed to `page`, which
                // would claim this is the current route.
                aria-current={current ? "location" : undefined}
                className="pointer-events-auto group flex items-center justify-end gap-2.5"
              >
                <span
                  className={cn(
                    "text-right font-mono text-[10px] uppercase tracking-widest transition-colors",
                    current ? "text-ink" : "text-muted group-hover:text-ink"
                  )}
                >
                  {labels[id]}
                </span>
                {/* The mark carries position redundantly with the label
                 * colour, so the state never rests on colour alone. */}
                <span
                  aria-hidden
                  className={cn(
                    "h-px transition-all",
                    current ? "w-6 bg-action" : "w-3 bg-hairline-strong"
                  )}
                />
              </a>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
