import { Section, SectionHeading } from "@web/components/section"
import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { UseCasePageCopy } from "@web/content/types"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilityGrid } from "./capability-grid"
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

  return (
    <SiteShell locale={locale} route={route}>
      <PageHeader copy={page.header} />

      <Section tone="paper">
        <p className="max-w-3xl border-l-2 border-hairline-strong pl-4 text-sm leading-relaxed text-muted">
          {page.provenance}
        </p>

        <h2 className="mt-16 font-mono text-xs uppercase tracking-widest text-muted">
          {page.scriptTitle}
        </h2>

        <ol className="mt-8 flex flex-col gap-px bg-hairline">
          {page.steps.map((step, index) => (
            <li
              key={step.rail}
              className="grid gap-4 bg-paper py-8 md:grid-cols-[10rem_1fr] md:gap-10"
            >
              <div>
                <p className="font-mono text-xs uppercase tracking-widest text-ink">{step.rail}</p>
                <p aria-hidden className="mt-1 font-mono text-xs text-muted">
                  {String(index + 1).padStart(2, "0")}
                </p>
              </div>
              <div>
                <h3 className="text-xl font-medium leading-snug text-ink">{step.title}</h3>
                <p className="mt-3 max-w-2xl leading-relaxed text-muted">{step.body}</p>
                <p className="mt-4 font-mono text-xs text-muted">{step.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section tone="surface">
        <SectionHeading title={page.capabilities.title} subtitle={page.capabilities.subtitle} />
        <div className="mt-12">
          <CapabilityGrid
            entries={page.capabilities.entries}
            learnMore={copy.common.learnMore}
            locale={locale}
            tone="surface"
            docsOrigin={docsUrl()}
          />
        </div>
      </Section>
    </SiteShell>
  )
}
