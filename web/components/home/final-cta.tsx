import { CountUp } from "@web/components/count-up"
import { DownloadCta } from "@web/components/download-cta"
import { Hairline } from "@web/components/hairline"
import { Icon, type IconName } from "@web/components/icon"
import { RevealGroup, RevealItem } from "@web/components/reveal-group"
import { Section, formatIndex } from "@web/components/section"
import { SiteLink } from "@web/components/site-link"
import type { FinalCtaRowKey, SiteCopy } from "@web/content/types"
import type { Evidence, ReleaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"

interface FinalCtaProps {
  locale: Locale
  copy: SiteCopy
  releaseState: ReleaseState
  evidence: Evidence
  docsOrigin?: string
  /** One-based position on the page, rendered as the eyebrow's index tag. */
  index?: number
}

const ROW_ICON: Record<FinalCtaRowKey, IconName> = {
  license: "license",
  platforms: "system",
  release: "repository",
  changes: "record",
}

/**
 * Final call to action (spec §4.8).
 *
 * One close, not a menu: the same primary/secondary pair the hero opened with,
 * plus the documentation as a quieter third link. Reusing `DownloadCta` means
 * the "no release yet" wording can never drift between the top and bottom of
 * the page.
 *
 * The right column answers the question the close actually raises — "what do I
 * get if I do this today?" — using only values already on the page: the licence
 * and changeset count from the evidence snapshot, the platform names and the
 * release state from the copy the CTA itself renders. Nothing here is a new
 * claim. A testimonial strip, a logo wall or a table of what a future release
 * *will* contain would all fill the same space and are all banned by spec §9;
 * this is the honest version.
 *
 * On the stage, like the hero: the page opens and closes on the execution
 * surface, with the paper argument between them. `stage-scope` remaps the
 * reading tokens so the same `DownloadCta`, rows and hairline render here
 * unchanged.
 */
export function FinalCta({
  locale,
  copy,
  releaseState,
  evidence,
  docsOrigin,
  index,
}: FinalCtaProps) {
  const { finalCta } = copy.home

  const values: Record<FinalCtaRowKey, { value: string | number; suffix?: string }> = {
    license: { value: evidence.repo?.license ?? copy.footer.licenseNote },
    platforms: {
      value: [
        copy.common.download.platformMacos,
        copy.common.download.platformWindows,
        copy.common.download.platformLinux,
      ].join(" · "),
    },
    release: {
      // `version` is nullable even when `hasRelease` is true, so fall through
      // to the same "no release yet" wording rather than rendering an empty row.
      value:
        (releaseState.hasRelease ? releaseState.version : null) ?? copy.home.trust.noReleasesYet,
    },
    changes: { value: evidence.changesets.length, suffix: finalCta.changesSuffix },
  }

  return (
    <Section id="start" tone="stage" density="open" className="stage-scope overflow-hidden">
      <div aria-hidden className="stage-grid pointer-events-none absolute inset-0 opacity-60" />
      <Hairline />
      <div className="pt-14 lg:grid lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:gap-16">
        <div>
          <p className="flex items-center gap-3 font-mono text-xs uppercase tracking-widest text-muted">
            {index !== undefined ? (
              <span
                data-slot="section-index"
                className="index-tick flex items-center gap-3 tabular-nums text-ink"
              >
                {formatIndex(index)}
              </span>
            ) : null}
            <span>{finalCta.eyebrow}</span>
          </p>
          <h2 className="mt-6 max-w-3xl text-balance text-3xl font-medium leading-tight tracking-tight text-ink md:text-4xl lg:text-5xl">
            {finalCta.title}
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
            <p className="font-mono text-xs text-muted">{finalCta.support}</p>
          </div>
        </div>

        <div className="mt-14 border-hairline lg:mt-0 lg:border-l lg:pl-14">
          <p className="font-mono text-xs uppercase tracking-widest text-muted">
            {finalCta.indexLabel}
          </p>
          <RevealGroup as="dl" count={finalCta.rows.length} className="mt-6 flex flex-col gap-px">
            {finalCta.rows.map((row) => {
              const entry = values[row.key]
              return (
                <RevealItem key={row.key} className="border-b border-hairline py-4 last:border-b-0">
                  <dt className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-muted">
                    <Icon name={ROW_ICON[row.key]} size={14} />
                    {row.label}
                  </dt>
                  <dd className="mt-2 text-sm text-ink">
                    <CountUp value={entry.value} />
                    {entry.suffix ? <span className="ml-2 text-muted">{entry.suffix}</span> : null}
                  </dd>
                </RevealItem>
              )
            })}
          </RevealGroup>
        </div>
      </div>
    </Section>
  )
}
