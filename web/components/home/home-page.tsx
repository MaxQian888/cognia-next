import { SectionIndexRail } from "@web/components/section-index-rail"
import { SiteShell, evidence } from "@web/components/site-shell"
import { ScrollProgress } from "@web/components/ui/scroll-progress"
import { getCopy } from "@web/content"
import { HOME_SECTIONS } from "@web/content/types"
import { releaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { RELEASES_URL, docsUrl } from "@web/lib/site"
import { Connections } from "./connections"
import { ContextTrace } from "./context-trace"
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
      <ScrollProgress />
      {/* Eight sections and nine thousand pixels with no chrome between them:
       * without this a reader partway down cannot tell how much argument is
       * left, or get back to a section they skimmed. */}
      <SectionIndexRail
        sections={HOME_SECTIONS}
        labels={copy.home.sectionIndex}
        label={copy.nav.sectionIndexLabel}
      />
      <Hero locale={locale} copy={copy} releaseState={state} docsOrigin={docsOrigin} />
      <ContextTrace copy={copy.home.contextTrace} />
      <SignatureDemo
        copy={copy.home.signature}
        reconstruction={copy.reconstruction}
        lensLabel={copy.home.lensLabel}
        fileTreeLabel={copy.home.fileTreeLabel}
        pointerLabel={copy.reconstruction.workbench.agentLabel}
      />
      <WorkbenchBento
        copy={copy.home.workbench}
        common={copy.common}
        reconstruction={copy.reconstruction}
      />
      <DesktopSection copy={copy.home.desktop} terminalCopy={copy.home.terminal} locale={locale} />
      <RunMatrix
        copy={copy.home.run}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <Connections copy={copy.home.connections} flowCopy={copy.home.connectionFlow} />
      <TrustSection
        copy={copy.home.trust}
        common={copy.common}
        evidence={evidence}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <FinalCta
        locale={locale}
        copy={copy}
        releaseState={state}
        evidence={evidence}
        docsOrigin={docsOrigin}
      />
    </SiteShell>
  )
}
