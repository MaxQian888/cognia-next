import type { ReactNode } from "react"

export type SectionTone = "paper" | "surface" | "stage"

/**
 * How much air a section gets.
 *
 * Measured against four peer sites (`docs/research/cognia-official-website-motion-craft-2026-08-01.md`),
 * the density contrast that reads as rhythm comes from *alternation*, not from
 * an even three-step ramp: Raycast alternates 168px against 0, and Zed and Warp
 * run at 0 throughout and let content volume do the work. An even
 * 128 / 160 / 192 ramp is too narrow a spread to be legible as a cadence — this
 * site shipped every section at a uniform 160 and measured a height spread of
 * only 1.86×, against 2.49–9.27× across the peers.
 *
 * `flush` is therefore genuinely 0: a section that carries its own internal
 * spacing, separated from its neighbour by a tone or border change rather than
 * by whitespace.
 */
export type SectionDensity = "flush" | "tight" | "normal" | "open"

/**
 * `offset` is the spec §2.3 "Off-Grid Editorial" pick, which had not landed.
 * The content column starts one track in from the shell edge, leaving a narrow
 * left channel for hung eyebrows, indices and rules — so the page stops reading
 * as a stack of centred containers.
 */
export type SectionAlign = "full" | "offset"

interface SectionProps {
  id?: string
  tone?: SectionTone
  density?: SectionDensity
  align?: SectionAlign
  /**
   * Draw the §2.3 vertical rhythm lines behind this section. They existed as a
   * utility but were used in exactly one place (the hero), so the structural
   * language the spec named as a headline component was invisible everywhere
   * else. Decorative, so the layer is `aria-hidden`.
   */
  rule?: boolean
  children: ReactNode
  className?: string
}

const TONE_CLASS: Record<SectionTone, string> = {
  paper: "bg-paper text-ink",
  surface: "bg-surface text-ink",
  // The dark execution stage. Its own text tokens are used rather than `ink`,
  // because `ink` flips with the theme while the stage stays dark in both.
  stage: "bg-stage text-on-stage",
}

const DENSITY_CLASS: Record<SectionDensity, string> = {
  flush: "py-0",
  tight: "py-12 md:py-16 lg:py-20",
  // The shipped value, kept as the default so no existing caller moves.
  normal: "py-24 md:py-32 lg:py-40",
  open: "py-32 md:py-44 lg:py-56",
}

const ALIGN_CLASS: Record<SectionAlign, string> = {
  full: "",
  // The channel only opens where there is room for it; below `lg` the section
  // is already narrow enough that indenting it would just cost line length.
  offset: "lg:pl-[calc(var(--spacing-shell)/12)]",
}

/**
 * A major page section (spec §7): one shell, one max width, and a vertical
 * rhythm chosen from a fixed set, so no section invents its own spacing.
 *
 * The rhythm is deliberately not uniform. See {@link SectionDensity}.
 */
export function Section({
  id,
  tone = "paper",
  density = "normal",
  align = "full",
  rule = false,
  children,
  className,
}: SectionProps) {
  return (
    <section id={id} className={`relative ${TONE_CLASS[tone]} ${className ?? ""}`}>
      {rule ? (
        <span
          aria-hidden
          className="rhythm-lines pointer-events-none absolute inset-x-0 top-0 hidden h-full opacity-50 md:block"
        />
      ) : null}
      <div
        className={`relative mx-auto max-w-shell px-5 lg:px-8 ${DENSITY_CLASS[density]} ${ALIGN_CLASS[align]}`}
      >
        {children}
      </div>
    </section>
  )
}

interface SectionHeadingProps {
  eyebrow?: string
  title: string
  subtitle?: string
  tone?: SectionTone
  className?: string
}

/**
 * Section headings use normal or medium weight, never a stack of ultra-bold
 * lines (spec §3.2). The eyebrow is monospaced because it functions as an index
 * label rather than as prose.
 */
export function SectionHeading({
  eyebrow,
  title,
  subtitle,
  tone = "paper",
  className,
}: SectionHeadingProps) {
  const onStage = tone === "stage"
  return (
    <div className={`max-w-3xl ${className ?? ""}`}>
      {eyebrow ? (
        <p
          className={`mb-6 font-mono text-xs uppercase tracking-widest ${
            onStage ? "text-on-stage-muted" : "text-muted"
          }`}
        >
          {eyebrow}
        </p>
      ) : null}
      <h2
        className={`text-balance text-3xl font-medium leading-tight tracking-tight md:text-4xl lg:text-5xl ${
          onStage ? "text-on-stage" : "text-ink"
        }`}
      >
        {title}
      </h2>
      {subtitle ? (
        <p
          className={`mt-6 max-w-2xl text-lg leading-relaxed ${
            onStage ? "text-on-stage-muted" : "text-muted"
          }`}
        >
          {subtitle}
        </p>
      ) : null}
    </div>
  )
}
