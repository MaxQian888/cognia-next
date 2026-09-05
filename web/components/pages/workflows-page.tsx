import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilitySections } from "./capability-sections"
import { PageHeader } from "./page-header"
import { RunnerGuarantees } from "./runner-guarantees"
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
        reconstruction={copy.reconstruction}
      />
      <SystemFlow
        copy={copy.workflows.flow}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <RunnerGuarantees copy={copy.workflows.guarantees} />
    </SiteShell>
  )
}
