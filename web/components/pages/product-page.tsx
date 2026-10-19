import type { ReactNode } from "react"
import { AgentRosterReconstruction } from "@web/components/product/agent-roster-reconstruction"
import { DesktopReconstruction } from "@web/components/product/desktop-reconstruction"
import { MemoryReconstruction } from "@web/components/product/memory-reconstruction"
import { ProductStage } from "@web/components/product-stage"
import { Reveal } from "@web/components/reveal"
import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilityPanorama } from "./capability-panorama"
import { CapabilitySections, type SectionExtras } from "./capability-sections"
import { PageHeader } from "./page-header"
import { PageClose } from "./page-close"

/** A reconstruction with its caption: the frame carries the honesty marker itself. */
function Figure({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure>
      {children}
      <figcaption className="mt-3 text-sm text-muted">{caption}</figcaption>
    </figure>
  )
}

/**
 * `/product` — the page the navigation's Product dropdown points into. Its
 * sections carry the `chat`, `agents`, `knowledge` and `desktop` anchors, so
 * those menu entries land on the right block rather than at the top.
 *
 * Each of the four sections sets its entries beside the surface it is about
 * (2026-10-19): the real chat capture, and labelled reconstructions for the
 * rest. The desktop capture is a crop of the same screen as the chat one, so
 * showing it twice would read as the page having one picture; the desktop
 * reconstruction shows the palette, terminal and notification the section's
 * entries name. The page closes on the subsystem map that used to sit on the
 * homepage, which replaces the four-card showcase that listed the same parts.
 * The agent interop index stays on the homepage's run section, not repeated
 * here (The Sub-page Depth Rule, in reverse).
 */
export function ProductPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const docsOrigin = docsUrl()
  const captions = copy.product.figureCaptions

  const extras: Record<string, SectionExtras> = {
    chat: {
      figure: (
        <Reveal variant="scale">
          <ProductStage
            section="workbench"
            locale={locale}
            alt={captions.chat}
            caption={captions.chat}
          />
        </Reveal>
      ),
    },
    agents: {
      figure: (
        <Reveal variant="scale">
          <Figure caption={captions.agents}>
            <AgentRosterReconstruction copy={copy.reconstruction} />
          </Figure>
        </Reveal>
      ),
    },
    knowledge: {
      figure: (
        <Reveal variant="scale">
          <Figure caption={captions.knowledge}>
            <MemoryReconstruction copy={copy.reconstruction} />
          </Figure>
        </Reveal>
      ),
    },
    desktop: {
      figure: (
        <Reveal variant="scale">
          <Figure caption={captions.desktop}>
            <DesktopReconstruction copy={copy.reconstruction} />
          </Figure>
        </Reveal>
      ),
    },
  }

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
        extras={extras}
      />
      <CapabilityPanorama
        copy={copy.product.panorama}
        common={copy.common}
        locale={locale}
        docsOrigin={docsOrigin}
      />
      <PageClose locale={locale} docsOrigin={docsOrigin} />
    </SiteShell>
  )
}
