import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import { SiteShell } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import type { Locale } from "@web/lib/locale"
import { docsUrl } from "@web/lib/site"
import { CapabilitySections } from "./capability-sections"
import { PageHeader } from "./page-header"
import { SystemFlow } from "./system-flow"

/**
 * `/trust`.
 *
 * The claim-and-source table is the page's point: every statement the site
 * makes anywhere resolves to a file, a workflow or an API response a reader can
 * open themselves. A trust page that asserts rather than cites is an
 * advertisement.
 */
export function TrustPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const docsOrigin = docsUrl()
  const { evidence } = copy.trust

  return (
    <SiteShell locale={locale} route="/trust">
      <PageHeader
        copy={copy.trust.header}
        common={copy.common}
        locale={locale}
        sections={copy.trust.sections}
        docsOrigin={docsOrigin}
      />
      <CapabilitySections
        sections={copy.trust.sections}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
        reconstruction={copy.reconstruction}
      />
      <SystemFlow
        copy={copy.trust.flow}
        learnMore={copy.common.learnMore}
        locale={locale}
        docsOrigin={docsOrigin}
      />

      <Section tone="paper">
        <SectionHeading title={evidence.title} subtitle={evidence.subtitle} />
        <div className="mt-12 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-hairline-strong">
                <th
                  scope="col"
                  className="py-3 pr-6 font-mono text-xs uppercase tracking-widest text-muted"
                >
                  {evidence.headings.claim}
                </th>
                <th
                  scope="col"
                  className="py-3 font-mono text-xs uppercase tracking-widest text-muted"
                >
                  {evidence.headings.source}
                </th>
              </tr>
            </thead>
            <tbody>
              {evidence.rows.map((row) => (
                <tr key={row.claim} className="border-b border-hairline align-top">
                  <th scope="row" className="py-5 pr-6 font-normal leading-relaxed text-ink">
                    {row.claim}
                  </th>
                  <td className="py-5 text-sm leading-relaxed text-muted">
                    <SiteLink
                      target={{ label: row.source, href: row.href, docsPath: row.docsPath }}
                      locale={locale}
                      docsOrigin={docsOrigin}
                      className="text-ink underline decoration-hairline-strong underline-offset-4"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </SiteShell>
  )
}
