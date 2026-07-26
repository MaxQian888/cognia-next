import type { ReactNode } from "react"

export type SectionTone = "paper" | "surface" | "stage"

interface SectionProps {
  id?: string
  tone?: SectionTone
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

/**
 * A major page section (spec §7): one shell, one max width, one vertical
 * rhythm, so no section invents its own spacing and the page keeps a measurable
 * cadence at 96 / 128 / 160px.
 */
export function Section({ id, tone = "paper", children, className }: SectionProps) {
  return (
    <section id={id} className={`${TONE_CLASS[tone]} ${className ?? ""}`}>
      <div className="mx-auto max-w-shell px-5 py-24 md:py-32 lg:px-8 lg:py-40">{children}</div>
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
