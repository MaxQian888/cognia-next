import { Section, SectionHeading } from "@web/components/section"
import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilitySections } from "./capability-sections"
import { PageHeader } from "./page-header"
import { SystemFlow } from "./system-flow"

/**
 * `/plugins`.
 *
 * Closes on authoring rather than on a plugin gallery: a gallery is a count
 * that has to be maintained, and the spec forbids hand-written ecosystem
 * numbers. Three ordered steps are what a reader who wants to build one needs.
 */
export function PluginsPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const docsOrigin = docsUrl()
  return (
    <SiteShell locale={locale} route="/plugins">
      <PageHeader
        copy={copy.plugins.header}
        common={copy.common}
        locale={locale}
        sections={copy.plugins.sections}
        docsOrigin={docsOrigin}
      />
      <CapabilitySections
        sections={copy.plugins.sections}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <SystemFlow
        copy={copy.plugins.flow}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <Section tone="paper">
        <SectionHeading
          title={copy.plugins.authoring.title}
          subtitle={copy.plugins.authoring.body}
        />
        <ol className="mt-10 flex max-w-3xl flex-col">
          {copy.plugins.authoring.steps.map((step, index) => (
            <li
              key={step}
              className="flex gap-5 border-t border-hairline py-5 first:border-t-0 first:pt-0"
            >
              <span aria-hidden className="font-mono text-xs text-muted">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span className="leading-relaxed text-ink">{step}</span>
            </li>
          ))}
        </ol>
      </Section>
    </SiteShell>
  )
}
