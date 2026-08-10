import { Hairline } from "@web/components/hairline"
import { Icon } from "@web/components/icon"
import { ProductStage } from "@web/components/product-stage"
import { Reveal } from "@web/components/reveal"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { Section, SectionHeading } from "@web/components/section"
import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { UseCasePageCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilityGrid } from "./capability-grid"
import { FeatureShowcase } from "./feature-showcase"
import { PageHeader } from "./page-header"

interface UseCasePageProps {
  locale: Locale
  variant: "development" | "research"
}

/**
 * `/use-cases/development` and `/use-cases/research`.
 *
 * Structured as a reproducible script, not a customer story: numbered steps,
 * each naming the capability it uses and linking to that capability's
 * documentation. The provenance line above the script says outright whether it
 * is dogfooding or a capability walkthrough — the spec forbids fabricated
 * testimonials, and the honest way to satisfy that is to state what the page is.
 */
export function UseCasePage({ locale, variant }: UseCasePageProps) {
  const copy = getCopy(locale)
  const page: UseCasePageCopy = copy.useCases[variant]
  const route = `/use-cases/${variant}`
  const docsOrigin = docsUrl()

  return (
    <SiteShell locale={locale} route={route}>
      <PageHeader copy={page.header} common={copy.common} locale={locale} docsOrigin={docsOrigin} />

      <Section tone="paper">
        <p className="flex max-w-3xl items-start gap-3 border-l-2 border-hairline-strong pl-4 text-sm leading-relaxed text-muted">
          <Icon name="info" size={16} className="mt-0.5" />
          {page.provenance}
        </p>

        <h2 className="mt-16 font-mono text-xs uppercase tracking-widest text-muted">
          {page.scriptTitle}
        </h2>

        {/* A rail rather than a stack of rows: the steps are a sequence, and
         * the drawn line is what says so. Same vocabulary as the signature
         * demo's rail, so the two pages read as one system. */}
        <div className="relative mt-8">
          <div aria-hidden className="absolute bottom-0 left-0 top-0 hidden w-px md:block">
            <Hairline orientation="y" tone="hairline-strong" />
          </div>

          <RevealGroup
            as="ol"
            count={page.steps.length}
            className="flex flex-col gap-px bg-hairline"
          >
            {page.steps.map((step, index) => (
              <RevealItem
                key={step.rail}
                as="li"
                className="trace relative grid gap-4 bg-paper py-8 md:grid-cols-[10rem_1fr] md:gap-10 md:pl-8"
              >
                <span
                  aria-hidden
                  className="absolute -left-[3px] top-10 hidden size-1.5 rounded-full bg-action md:block"
                />
                <div>
                  <p className="font-mono text-xs uppercase tracking-widest text-ink">
                    {step.rail}
                  </p>
                  <p aria-hidden className="mt-1 font-mono text-xs text-muted">
                    {String(index + 1).padStart(2, "0")}
                  </p>
                </div>
                <div>
                  <h3 className="text-xl font-medium leading-snug text-ink">{step.title}</h3>
                  <p className="mt-3 max-w-2xl leading-relaxed text-muted">{step.body}</p>
                  <p className="mt-4 font-mono text-xs text-muted">{step.detail}</p>
                </div>
              </RevealItem>
            ))}
          </RevealGroup>
        </div>

        {/* These two pages carried no visual at all. The workbench stage is
         * already built, already labelled as a reconstruction, and already
         * describes this very task — and it gives the `workbench` capture
         * cells their first real consumer on the site. */}
        <Reveal variant="scale" className="mt-16">
          <ProductStage
            section="workbench"
            locale={locale}
            alt={page.stageAlt}
            caption={page.stageCaption}
          />
        </Reveal>
      </Section>

      <FeatureShowcase
        copy={page.showcase}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />

      <Section tone="surface">
        <SectionHeading title={page.capabilities.title} subtitle={page.capabilities.subtitle} />
        <div className="mt-12">
          <CapabilityGrid
            entries={page.capabilities.entries}
            learnMore={copy.common.learnMore}
            locale={locale}
            tone="surface"
            docsOrigin={docsOrigin}
          />
        </div>
      </Section>
    </SiteShell>
  )
}
