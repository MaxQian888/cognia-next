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

/** A readable boundary-by-boundary path shared by workflow, plugin, and trust pages. */
export function SystemFlow({ copy, learnMore, locale, docsOrigin }: SystemFlowProps) {
  return (
    <Section tone="paper" density="normal">
      <div className="lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <SectionHeading title={copy.title} subtitle={copy.subtitle} className="max-w-4xl" />

        <div className="relative mt-12 lg:mt-0">
          <div
            aria-hidden
            className="absolute left-8 top-0 hidden h-full w-px md:block lg:left-0 lg:top-8 lg:h-px lg:w-full"
          >
            <Hairline orientation="y" tone="hairline-strong" className="lg:hidden" />
            <Hairline tone="hairline-strong" className="hidden lg:block" />
          </div>

          <RevealGroup
            as="ol"
            count={copy.steps.length}
            data-slot="system-flow"
            className="relative grid grid-flow-dense gap-px bg-hairline md:grid-cols-2 lg:grid-cols-4"
          >
            {copy.steps.map((step, index) => (
              <RevealItem key={step.key} as="li" className="flex min-w-0 flex-col bg-paper p-6">
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
