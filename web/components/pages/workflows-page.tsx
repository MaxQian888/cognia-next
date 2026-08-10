import { Section, SectionHeading } from "@web/components/section"
import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilitySections } from "./capability-sections"
import { PageHeader } from "./page-header"
import { SystemFlow } from "./system-flow"

/**
 * `/workflows`.
 *
 * The closing block states what the runner guarantees rather than what it can
 * do. "Cycles are rejected when the graph is saved" is a checkable property; a
 * feature list is not, and this is the page where the core differentiator has
 * to hold up.
 */
export function WorkflowsPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const docsOrigin = docsUrl()
  return (
    <SiteShell locale={locale} route="/workflows">
      <PageHeader
        copy={copy.workflows.header}
        common={copy.common}
        locale={locale}
        sections={copy.workflows.sections}
        docsOrigin={docsOrigin}
      />
      <CapabilitySections
        sections={copy.workflows.sections}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <SystemFlow
        copy={copy.workflows.flow}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <Section tone="stage">
        <SectionHeading title={copy.workflows.guarantees.title} tone="stage" />
        <ul className="mt-10 flex max-w-3xl flex-col">
          {copy.workflows.guarantees.items.map((item) => (
            <li
              key={item}
              className="border-t border-on-stage-hairline py-5 text-on-stage-muted first:border-t-0 first:pt-0"
            >
              <span aria-hidden className="mr-3 text-action">
                —
              </span>
              {item}
            </li>
          ))}
        </ul>
      </Section>
    </SiteShell>
  )
}
