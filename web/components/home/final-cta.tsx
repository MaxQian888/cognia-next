import { DownloadCta } from "@web/components/download-cta"
import { Section } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { SiteCopy } from "@web/content/types"
import type { ReleaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface FinalCtaProps {
  locale: Locale
  copy: SiteCopy
  releaseState: ReleaseState
  docsOrigin?: string
}

/**
 * Final call to action (spec §4.8).
 *
 * One close, not a menu: the same primary/secondary pair the hero opened with,
 * plus the documentation as a quieter third link. Reusing `DownloadCta` means
 * the "no release yet" wording can never drift between the top and bottom of
 * the page.
 */
export function FinalCta({ locale, copy, releaseState, docsOrigin }: FinalCtaProps) {
  return (
    <Section tone="paper">
      <div className="border-t border-hairline pt-14">
        <h2 className="max-w-3xl text-balance text-3xl font-medium leading-tight tracking-tight text-ink md:text-4xl lg:text-5xl">
          {copy.home.finalCta.title}
        </h2>

        <div className="mt-10">
          <DownloadCta
            locale={locale}
            copy={copy.common}
            state={releaseState}
            docsOrigin={docsOrigin}
          />
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-6">
          <SiteLink
            target={{ label: copy.common.readDocs, docsPath: "/docs" }}
            locale={locale}
            docsOrigin={docsOrigin}
            className="font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
          />
          <p className="font-mono text-xs text-muted">{copy.home.finalCta.support}</p>
        </div>
      </div>
    </Section>
  )
}
