import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilitySections } from "./capability-sections"
import { FeatureShowcase } from "./feature-showcase"
import { PageHeader } from "./page-header"

/**
 * `/product` — the page the navigation's Product dropdown points into. Its
 * sections carry the `chat`, `agents`, `knowledge` and `desktop` anchors, so
 * those menu entries land on the right block rather than at the top.
 */
export function ProductPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const docsOrigin = docsUrl()
  return (
    <SiteShell locale={locale} route="/product">
      <PageHeader
        copy={copy.product.header}
        common={copy.common}
        locale={locale}
        sections={copy.product.sections}
        docsOrigin={docsOrigin}
      />
      <CapabilitySections
        sections={copy.product.sections}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
        reconstruction={copy.reconstruction}
      />
      <FeatureShowcase
        copy={copy.product.showcase}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
    </SiteShell>
  )
}
