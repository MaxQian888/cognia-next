import { Section, SectionHeading } from "@web/components/section"
import type { CapabilitySection } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import { CapabilityGrid } from "./capability-grid"

interface CapabilitySectionsProps {
  sections: CapabilitySection[]
  learnMore: string
  locale: Locale
  docsOrigin?: string
}

/**
 * The body shared by /product, /workflows, /plugins and /trust.
 *
 * Alternating tones keep long pages from reading as one undifferentiated
 * column, and each section carries its anchor id so the navigation dropdown and
 * the footer land on the right block.
 */
export function CapabilitySections({
  sections,
  learnMore,
  locale,
  docsOrigin,
}: CapabilitySectionsProps) {
  return (
    <>
      {sections.map((section, index) => {
        const tone = index % 2 === 0 ? "paper" : "surface"
        return (
          <Section key={section.title} id={section.id} tone={tone}>
            <SectionHeading title={section.title} subtitle={section.subtitle} />
            <div className="mt-12">
              <CapabilityGrid
                entries={section.entries}
                learnMore={learnMore}
                locale={locale}
                tone={tone}
                docsOrigin={docsOrigin}
              />
            </div>
          </Section>
        )
      })}
    </>
  )
}
