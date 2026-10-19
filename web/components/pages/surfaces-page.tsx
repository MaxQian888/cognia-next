import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilitySections } from "./capability-sections"
import { EntryPoints } from "./entry-points"
import { PageHeader } from "./page-header"
import { SystemFlow } from "./system-flow"
import { PageClose } from "./page-close"

/**
 * `/surfaces` — where the work can be reached from.
 *
 * Opens on the station rail the homepage used to carry (one task handed from
 * the desktop to a phone, a chat, a terminal and the browser), then gives each
 * station its own block anchored by its key, so the homepage's surfaces strip
 * and the navigation land on the right one. Closes on the lifecycle every
 * non-desktop surface shares, because "what can this device do" is answered
 * by its grant, not by the app it runs.
 */
export function SurfacesPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const docsOrigin = docsUrl()
  return (
    <SiteShell locale={locale} route="/surfaces">
      <PageHeader
        copy={copy.surfaces.header}
        common={copy.common}
        locale={locale}
        sections={copy.surfaces.sections}
        docsOrigin={docsOrigin}
      />
      <EntryPoints copy={copy.surfaces.entryPoints} reconstruction={copy.reconstruction} />
      <CapabilitySections
        sections={copy.surfaces.sections}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
        startTone="surface"
      />
      <SystemFlow
        copy={copy.surfaces.flow}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <PageClose locale={locale} docsOrigin={docsOrigin} />
    </SiteShell>
  )
}
