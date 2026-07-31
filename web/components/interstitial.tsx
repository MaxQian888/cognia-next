import type { ReactNode } from "react"
import { Hairline } from "@web/components/hairline"

interface InterstitialProps {
  /**
   * A monospaced index label, sitting in the left channel on wide viewports.
   * It is an index mark, not prose — the same role the eyebrow plays in
   * `SectionHeading`.
   */
  eyebrow?: string
  /** The single line this block exists to say. */
  statement: string
  /** Optional trailing detail — a count, a date, a qualifier. */
  detail?: ReactNode
  className?: string
}

/**
 * A short block between two tall sections.
 *
 * This is the piece the page was missing, and it is worth stating why, because
 * the obvious diagnosis is wrong.
 *
 * Measuring four peer sites at 1512px
 * (`docs/research/cognia-official-website-motion-craft-2026-08-01.md`) showed
 * this site's eight home sections landing in a height spread of 1.86×, against
 * 2.49–9.27× for the peers — so the reading was "vary the section heights".
 * But Linear, the site that reads as having the most rhythm of the four, runs
 * its five main body sections at a spread of only **1.19×** — flatter than this
 * one. What breaks up its page is not variation *between* the tall sections; it
 * is the short blocks placed *between* them: a 132px standalone statement, a
 * 360px compact strip, a 172px pre-footer.
 *
 * A 130px block between two 1200px blocks is what a reader registers as a
 * breath. Two 1000px blocks next to a 1400px one is not — that difference is
 * invisible at reading speed.
 *
 * So this renders deliberately small and refuses to grow: one line, an optional
 * index, an optional trailing detail. It carries no heading, because it is not
 * a section — it is the gap between two of them, given something to say. It is
 * therefore not a landmark and does not appear in the section rail.
 *
 * The rule above it draws itself on entry (**Draw**), which is the site's own
 * idiom for a measurement mark rather than a decoration.
 */
export function Interstitial({ eyebrow, statement, detail, className }: InterstitialProps) {
  return (
    <div className={`bg-paper ${className ?? ""}`}>
      <div className="mx-auto max-w-shell px-5 lg:px-8">
        <Hairline />
        <div className="grid gap-4 py-10 md:grid-cols-[10rem_1fr] md:gap-10 md:py-12">
          {eyebrow ? (
            <p className="font-mono text-xs uppercase tracking-widest text-muted">{eyebrow}</p>
          ) : (
            // Holds the channel open so a block without an index still aligns
            // with the ones that have it. A `div` rather than a `span` so it is
            // distinguishable from `Hairline`, which is also an aria-hidden
            // inline element in this subtree.
            <div aria-hidden className="hidden md:block" />
          )}
          <div className="flex flex-col gap-2 md:flex-row md:items-baseline md:justify-between md:gap-10">
            <p className="text-balance text-lg leading-relaxed text-ink md:text-xl">{statement}</p>
            {detail ? (
              <div className="shrink-0 font-mono text-xs uppercase tracking-widest text-muted">
                {detail}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
