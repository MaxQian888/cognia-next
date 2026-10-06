import { SectionIndexRail } from "@web/components/section-index-rail"
import { SiteShell, evidence } from "@web/components/site-shell"
import { ScrollProgress } from "@web/components/ui/scroll-progress"
import { getCopy } from "@web/content"
import { HOME_SECTIONS, type HomeSectionId } from "@web/content/types"
import { releaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { findVideo } from "@web/lib/product-videos"
import { RELEASES_URL, docsUrl } from "@web/lib/site"
import { CapabilityPanorama } from "./capability-panorama"
import { Connections } from "./connections"
import { ContextTrace } from "./context-trace"
import { DesktopSection } from "./desktop-section"
import { EntryPoints } from "./entry-points"
import { FilmSection } from "./film-section"
import { FinalCta } from "./final-cta"
import { Hero } from "./hero"
import { RunMatrix } from "./run-matrix"
import { SignatureDemo } from "./signature-demo"
import { TrustSection } from "./trust-section"
import { WorkbenchBento } from "./workbench-bento"

/**
 * The homepage, in the order the spec fixes (§4): hero, the film, one task end
 * to end, the workbench, desktop, run strategies, connections, trust, close.
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
  // The film section exists only when its render does; the rail and the index
  // tags are derived from the sections actually rendered, so neither ever
  // points at one that is not on the page.
  const film = findVideo("product-film", locale)
  const sections = HOME_SECTIONS.filter((id) => id !== "film" || film !== null)
  const index = (id: HomeSectionId) => sections.indexOf(id) + 1

  return (
    <SiteShell locale={locale} route="/">
      <ScrollProgress />
      {/* Eight sections and nine thousand pixels with no chrome between them:
       * without this a reader partway down cannot tell how much argument is
       * left, or get back to a section they skimmed. */}
      <SectionIndexRail
        sections={sections}
        labels={copy.home.sectionIndex}
        label={copy.nav.sectionIndexLabel}
      />
      <Hero
        locale={locale}
        copy={copy}
        releaseState={state}
        docsOrigin={docsOrigin}
        index={index("hero")}
      />
      {film ? (
        <FilmSection
          copy={copy.home.film}
          footage={copy.footage}
          locale={locale}
          video={film}
          index={index("film")}
        />
      ) : null}
      <ContextTrace copy={copy.home.contextTrace} />
      <SignatureDemo
        copy={copy.home.signature}
        reconstruction={copy.reconstruction}
        fileTreeLabel={copy.home.fileTreeLabel}
        index={index("task")}
      />
      <WorkbenchBento
        copy={copy.home.workbench}
        common={copy.common}
        reconstruction={copy.reconstruction}
        index={index("workbench")}
      />
      <DesktopSection
        copy={copy.home.desktop}
        terminalCopy={copy.home.terminal}
        locale={locale}
        lensLabel={copy.home.lensLabel}
        index={index("desktop")}
      />
      <EntryPoints
        copy={copy.home.entryPoints}
        reconstruction={copy.reconstruction}
        index={index("entries")}
      />
      <RunMatrix
        copy={copy.home.run}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
        index={index("run")}
      />
      <Connections
        copy={copy.home.connections}
        flowCopy={copy.home.connectionFlow}
        index={index("connections")}
      />
      <CapabilityPanorama
        copy={copy.home.panorama}
        common={copy.common}
        inventory={evidence.inventory}
        locale={locale}
        docsOrigin={docsOrigin}
        index={index("system")}
      />
      <TrustSection
        copy={copy.home.trust}
        common={copy.common}
        evidence={evidence}
        locale={locale}
        docsOrigin={docsOrigin}
        index={index("trust")}
      />
      <FinalCta
        locale={locale}
        copy={copy}
        releaseState={state}
        evidence={evidence}
        docsOrigin={docsOrigin}
        index={index("start")}
      />
    </SiteShell>
  )
}
