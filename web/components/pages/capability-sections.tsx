import { Hairline } from "@web/components/hairline"
import { Icon, type IconName } from "@web/components/icon"
import { Section } from "@web/components/section"
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
 * One mark per section, keyed by the anchor the section already carries.
 *
 * Icons are presentation, not content, so they live here rather than in
 * `SiteCopy` — a translator has nothing to say about them, and a section with
 * no entry simply renders without one.
 */
const SECTION_ICON: Record<string, IconName> = {
  chat: "chat",
  agents: "agents",
  knowledge: "knowledge",
  desktop: "system",
  build: "workflow",
  run: "play",
  observe: "record",
  authoring: "plugin",
  capabilities: "approval",
  surfaces: "plugin",
  source: "source",
  data: "data",
  permission: "approval",
  record: "record",
}

/**
 * The body shared by /product, /workflows, /plugins and /trust.
 *
 * Alternating tones keep long pages from reading as one undifferentiated
 * column, and each section carries its anchor id so the navigation dropdown and
 * the footer land on the right block.
 *
 * The heading splits into two columns from `lg`. In one column a one-line title
 * sits directly on top of a three-line subtitle inside `max-w-3xl` of a 1480px
 * shell — the same crowding as the old hero, repeated three or four times per
 * page.
 *
 * The vertical rhythm alternates as well, and that is the more important half.
 * Tone alone gives a boundary between two blocks; it does not give the page a
 * cadence, because both blocks are still the same size. Measured against four
 * peer sites (`docs/research/cognia-official-website-motion-craft-2026-08-01.md`),
 * the mechanism that reads as rhythm is alternation between a generous value
 * and a much smaller one — Raycast runs 168px against 0 — not an even ramp
 * across three similar values. With `/product` growing from four capability
 * sections to six, a page of six identically-spaced blocks is exactly the
 * failure this alternation exists to avoid.
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
        // The first block sets the page's upper bound; after it the rhythm
        // alternates, so no two adjacent sections are the same height.
        const density = index === 0 ? "open" : index % 2 === 1 ? "tight" : "normal"
        const icon = section.id ? SECTION_ICON[section.id] : undefined
        return (
          <Section
            key={section.title}
            id={section.id}
            tone={tone}
            density={density}
            // Only on the opening block: the rhythm lines are a structural mark
            // for where the page begins its index, not a texture to repeat.
            rule={index === 0}
          >
            <div className="lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
              <div>
                {/* Derived from position, not authored — a numbered index is
                 * the site's own idiom and needs no content key. */}
                <div className="flex items-center gap-3">
                  <Hairline className="w-10 shrink-0" tone="hairline-strong" />
                  <span className="font-mono text-xs uppercase tracking-widest text-muted">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                </div>
                <h2 className="mt-6 flex items-start gap-3 text-balance text-3xl font-medium leading-tight tracking-tight text-ink md:text-4xl lg:text-5xl">
                  {icon ? <Icon name={icon} size={20} className="mt-2 text-muted" /> : null}
                  {section.title}
                </h2>
              </div>
              <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted lg:mt-0 lg:self-end lg:pb-2">
                {section.subtitle}
              </p>
            </div>

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
