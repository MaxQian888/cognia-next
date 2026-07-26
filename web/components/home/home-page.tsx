import { SiteShell, evidence } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import { releaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { RELEASES_URL, docsUrl } from "@web/lib/site"
import { Connections } from "./connections"
import { DesktopSection } from "./desktop-section"
import { FinalCta } from "./final-cta"
import { Hero } from "./hero"
import { RunMatrix } from "./run-matrix"
import { SignatureDemo } from "./signature-demo"
import { TrustSection } from "./trust-section"
import { WorkbenchBento } from "./workbench-bento"

/**
 * The homepage, in the order the spec fixes (§4): hero, one task end to end,
 * the workbench, desktop, run strategies, connections, trust, close.
 *
 * The order is not a layout preference — it answers the reader's questions in
 * the sequence they arrive: what is this, how does it work, why is it one
 * product, why install it, what does it cost me in data, what can it reach, why
 * trust it, what now.
 */
export function HomePage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const state = releaseState(evidence, RELEASES_URL)
  const docsOrigin = docsUrl()

  return (
    <SiteShell locale={locale} route="/">
      <Hero locale={locale} copy={copy} releaseState={state} docsOrigin={docsOrigin} />
      <SignatureDemo copy={copy.home.signature} reconstruction={copy.reconstruction} />
      <WorkbenchBento
        copy={copy.home.workbench}
        common={copy.common}
        reconstruction={copy.reconstruction}
      />
      <DesktopSection copy={copy.home.desktop} locale={locale} />
      <RunMatrix
        copy={copy.home.run}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <Connections copy={copy.home.connections} />
      <TrustSection
        copy={copy.home.trust}
        common={copy.common}
        evidence={evidence}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <FinalCta locale={locale} copy={copy} releaseState={state} docsOrigin={docsOrigin} />
    </SiteShell>
  )
}
