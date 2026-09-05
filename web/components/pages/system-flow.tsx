"use client"

import { useInView, useReducedMotion } from "motion/react"
import { useRef, type CSSProperties } from "react"

import { Hairline } from "@web/components/hairline"
import { Icon, type IconName } from "@web/components/icon"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { SystemFlowCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface SystemFlowProps {
  copy: SystemFlowCopy
  learnMore: string
  locale: Locale
  docsOrigin?: string
}

const STEP_ICON: IconName[] = ["action", "files", "approval", "record"]

/** How long the marker rests at each boundary before moving on. */
export const FLOW_STEP_MS = 900

/**
 * A readable boundary-by-boundary path shared by workflow, plugin, and trust pages.
 *
 * Once the path is on screen, a marker travels the rule above the steps and
 * each step's top rule lights as it is reached, so the four boxes read as one
 * run crossing four boundaries rather than four cards. The motion runs once.
 * Reduced motion renders every boundary lit with the marker at the end.
 */
export function SystemFlow({ copy, learnMore, locale, docsOrigin }: SystemFlowProps) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion() ?? false
  const inView = useInView(ref, { once: true, amount: 0.4 })
  const live = inView && !reduced
  const last = copy.steps.length - 1

  return (
    <Section tone="paper" density="normal">
      <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <SectionHeading title={copy.title} subtitle={copy.subtitle} className="max-w-4xl" />

        <div
          ref={ref}
          data-slot="flow-rail"
          data-live={live || undefined}
          className="relative mt-12 lg:mt-0"
        >
          <div
            aria-hidden
            className="absolute left-8 top-0 hidden h-full w-px md:block lg:left-0 lg:top-8 lg:h-px lg:w-full"
          >
            <Hairline orientation="y" tone="hairline-strong" className="lg:hidden" />
            <Hairline tone="hairline-strong" className="hidden lg:block" />
            {live ? (
              <span
                data-slot="flow-marker"
                className="handoff-marker absolute top-1/2 hidden size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-action lg:block"
                style={{ "--handoff-duration": `${FLOW_STEP_MS * last}ms` } as CSSProperties}
              />
            ) : null}
          </div>

          <RevealGroup
            as="ol"
            count={copy.steps.length}
            className="relative grid grid-flow-dense gap-px bg-hairline md:grid-cols-2 lg:grid-cols-4"
          >
            {copy.steps.map((step, index) => (
              <RevealItem
                key={step.key}
                as="li"
                className={`relative flex min-w-0 flex-col bg-paper p-6 ${inView ? "station-lit" : ""}`}
                style={
                  { "--station-delay": `${live ? index * FLOW_STEP_MS : 0}ms` } as CSSProperties
                }
              >
                <span className="flex size-9 items-center justify-center rounded-control border border-hairline-strong bg-paper">
                  <Icon name={STEP_ICON[index] ?? "action"} size={16} className="text-muted" />
                </span>
                <p aria-hidden className="mt-8 font-mono text-[10px] text-muted">
                  {String(index + 1).padStart(2, "0")}
                </p>
                <h3 className="mt-3 text-lg font-medium text-ink">{step.label}</h3>
                <p className="mt-3 flex-1 text-sm leading-relaxed text-muted">{step.body}</p>
                {step.docsPath ? (
                  <SiteLink
                    target={{ label: learnMore, docsPath: step.docsPath }}
                    locale={locale}
                    docsOrigin={docsOrigin}
                    className="mt-6 font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
                  />
                ) : null}
              </RevealItem>
            ))}
          </RevealGroup>
        </div>
      </div>
    </Section>
  )
}
