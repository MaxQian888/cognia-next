import { SectionIndexRail } from "@web/components/section-index-rail"
import { SiteShell, evidence } from "@web/components/site-shell"
import { ScrollProgress } from "@web/components/ui/scroll-progress"
import { getCopy } from "@web/content"
import { HOME_SECTIONS, type HomeSectionId } from "@web/content/types"
import { releaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { findVideo } from "@web/lib/product-videos"
import { RELEASES_URL, docsUrl } from "@web/lib/site"
import { DesktopSection } from "./desktop-section"
import { FaqSection } from "./faq-section"
import { FinalCta } from "./final-cta"
import { Hero } from "./hero"
import { RunMatrix } from "./run-matrix"
import { SignatureDemo } from "./signature-demo"
import { TaskFilm } from "./task-film"
import { TrustSection } from "./trust-section"
import { UseCaseLinks } from "./use-case-links"
import { WorkbenchBento } from "./workbench-bento"

/**
 * The homepage, in the order the spec fixes (§4, revised 2026-10-19): hero, one
 * task end to end, the workbench, desktop, run strategies, trust, questions,
 * close.
 *
 * The order is not a layout preference — it answers the reader's questions in
 * the sequence they arrive: what is this, how does it work, why is it one
 * product, why install it, what does it cost me in data, why trust it, what is
 * still unclear, what now.
 *
 * The revision folded eleven sections to eight. Three answered questions the
 * sub-pages answer in full, and the homepage repeated them at a third of the
 * depth: the device handoff now opens /surfaces (the desktop section closes on
 * a strip into it), connection boundaries live on /plugins, and the subsystem
 * map closes /product. The build-time figures joined the trust evidence and
 * the agent interop index joined the run strategies. The film and the stepped
 * task told one task in two neighbouring sections, with a scrolling strip of
 * the same task's signals between them; the film now opens the task section
 * and the strip is gone.
 */
export function HomePage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const state = releaseState(evidence, RELEASES_URL)
  const docsOrigin = docsUrl()
  // The film exists only when its render does; the task section then opens
  // on the steps alone.
  const film = findVideo("product-film", locale)
  const sections = HOME_SECTIONS
  const index = (id: HomeSectionId) => sections.indexOf(id) + 1

  return (
    <SiteShell locale={locale} route="/">
      <ScrollProgress />
      {/* Eight sections and several thousand pixels with no chrome between them:
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
      <SignatureDemo
        copy={copy.home.signature}
        reconstruction={copy.reconstruction}
        fileTreeLabel={copy.home.fileTreeLabel}
        index={index("task")}
        film={
          film ? (
            <TaskFilm copy={copy.home.film} footage={copy.footage} locale={locale} video={film} />
          ) : undefined
        }
        footer={
          <UseCaseLinks
            label={copy.home.signature.useCasesLabel}
            items={copy.nav.useCasesMenu.items}
            locale={locale}
            docsOrigin={docsOrigin}
          />
        }
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
        stations={copy.surfaces.entryPoints.stations}
        docsOrigin={docsOrigin}
        index={index("desktop")}
      />
      <RunMatrix
        copy={copy.home.run}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
        index={index("run")}
      />
      <TrustSection
        copy={copy.home.trust}
        common={copy.common}
        inventoryCopy={copy.inventory}
        evidence={evidence}
        locale={locale}
        docsOrigin={docsOrigin}
        index={index("trust")}
      />
      <FaqSection
        copy={copy.home.faq}
        locale={locale}
        docsOrigin={docsOrigin}
        index={index("faq")}
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
