import { DownloadCta } from "@web/components/download-cta"
import { Section, SectionHeading } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import { evidence } from "@web/components/site-shell"
import { getCopy } from "@web/content"
import { releaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { RELEASES_URL } from "@web/lib/site"

interface PageCloseProps {
  locale: Locale
  docsOrigin?: string
}

/**
 * The band that closes a sub-page: one heading, the build/source pair and the
 * documentation, on the execution stage.
 *
 * Sub-pages used to end on their last list and drop into the footer, so a
 * reader convinced by /product had to scroll back up to the bar to act. This
 * is the homepage's close at sub-page depth — the same `DownloadCta`, so the
 * "no release yet" wording can never differ between pages — and the same
 * stage, so every page on the site ends on the surface it argues for.
 */
export function PageClose({ locale, docsOrigin }: PageCloseProps) {
  const copy = getCopy(locale)
  const state = releaseState(evidence, RELEASES_URL)
  const close = copy.common.pageClose

  return (
    <Section tone="stage" density="tight" className="stage-scope">
      <div
        data-slot="page-close"
        className="flex flex-col gap-10 lg:flex-row lg:items-end lg:justify-between"
      >
        <SectionHeading
          tone="stage"
          eyebrow={close.eyebrow}
          title={close.title}
          subtitle={close.body}
        />
        <div className="flex shrink-0 flex-col gap-5 lg:items-end">
          <DownloadCta locale={locale} copy={copy.common} state={state} docsOrigin={docsOrigin} />
          <SiteLink
            target={{ label: copy.common.readDocs, docsPath: "/docs" }}
            locale={locale}
            docsOrigin={docsOrigin}
            className="font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
          />
        </div>
      </div>
    </Section>
  )
}
