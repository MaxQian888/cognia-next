import { Icon, type IconName } from "@web/components/icon"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { FeatureShowcaseCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"

interface FeatureShowcaseProps {
  copy: FeatureShowcaseCopy
  learnMore: string
  locale: Locale
  docsOrigin?: string
}

const ITEM_SPAN = ["lg:col-span-7", "lg:col-span-5", "lg:col-span-5", "lg:col-span-7"]
const ITEM_ICON: IconName[] = ["files", "appWindow", "external", "workflow"]

/**
 * A four-part product proof rather than another uniform feature grid.
 *
 * At `lg`, two rows close exactly across twelve columns: 7 + 5 and 5 + 7.
 * Below that breakpoint every proof becomes a complete single-column record.
 */
export function FeatureShowcase({ copy, learnMore, locale, docsOrigin }: FeatureShowcaseProps) {
  return (
    <Section tone="stage" density="open">
      <SectionHeading
        title={copy.title}
        subtitle={copy.subtitle}
        tone="stage"
        className="max-w-5xl"
      />

      <RevealGroup
        as="ul"
        count={copy.items.length}
        data-slot="feature-showcase"
        className="mt-14 grid grid-flow-dense grid-cols-1 gap-px bg-on-stage-hairline lg:grid-cols-12"
      >
        {copy.items.map((item, index) => (
          <RevealItem
            key={item.key}
            as="li"
            className={`group min-h-64 overflow-hidden bg-graphite p-6 md:p-8 ${ITEM_SPAN[index] ?? "lg:col-span-6"}`}
          >
            <div className="flex h-full flex-col">
              <div className="flex items-center justify-between gap-6">
                <Icon
                  name={ITEM_ICON[index] ?? "system"}
                  size={20}
                  className="text-on-stage-muted"
                />
                <span aria-hidden className="font-mono text-[10px] text-on-stage-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>
              </div>
              <h3 className="mt-12 max-w-xl text-2xl font-medium leading-tight tracking-tight text-on-stage md:text-3xl">
                {item.title}
              </h3>
              <p className="mt-4 max-w-2xl flex-1 leading-relaxed text-on-stage-muted">
                {item.body}
              </p>
              <div className="mt-10 flex flex-wrap items-end justify-between gap-5 border-t border-on-stage-hairline pt-5">
                <p className="font-mono text-[10px] uppercase tracking-widest text-on-stage-muted">
                  {item.detail}
                </p>
                {item.docsPath ? (
                  <SiteLink
                    target={{ label: learnMore, docsPath: item.docsPath }}
                    locale={locale}
                    docsOrigin={docsOrigin}
                    className="font-mono text-xs text-on-stage underline decoration-on-stage-hairline underline-offset-4 transition-opacity group-hover:opacity-70"
                  />
                ) : null}
              </div>
            </div>
          </RevealItem>
        ))}
      </RevealGroup>
    </Section>
  )
}
