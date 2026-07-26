import { DownloadCta } from "@web/components/download-cta"
import { Section, SectionHeading } from "@web/components/section"
import { SiteShell, evidence } from "@web/components/site-shell"
import { format, getCopy } from "@web/content"
import { type Platform, formatDate, releaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { RELEASES_URL, docsUrl } from "@web/lib/site"
import { PageHeader } from "./page-header"

/**
 * `/download`.
 *
 * The page every download CTA on the site points at, and the one place the
 * "there is no release yet" state has to be fully honest rather than merely
 * quiet: it leads with build-from-source instructions, lists the real
 * prerequisites, and only shows per-platform installers once the release
 * manifest actually holds them.
 */
export function DownloadPage({ locale }: { locale: Locale }) {
  const copy = getCopy(locale)
  const state = releaseState(evidence, RELEASES_URL)
  const platforms: Array<{ key: Platform; label: string }> = [
    { key: "macos", label: copy.common.download.platformMacos },
    { key: "windows", label: copy.common.download.platformWindows },
    { key: "linux", label: copy.common.download.platformLinux },
  ]

  return (
    <SiteShell locale={locale} route="/download">
      <PageHeader copy={copy.download.header} />

      <Section tone="paper">
        <DownloadCta locale={locale} copy={copy.common} state={state} docsOrigin={docsUrl()} />

        {state.hasRelease ? (
          <div className="mt-16">
            <h2 className="font-mono text-xs uppercase tracking-widest text-muted">
              {copy.download.platformsTitle}
            </h2>
            <p className="mt-4 font-mono text-xs text-muted">
              {copy.common.download.version} {state.version} · {copy.common.download.published}{" "}
              {formatDate(state.publishedAt)}
            </p>
            <div className="mt-8 grid gap-px bg-hairline md:grid-cols-3">
              {platforms.map((platform) => (
                <div key={platform.key} className="bg-paper p-6">
                  <p className="font-medium text-ink">{platform.label}</p>
                  <ul className="mt-4 flex flex-col gap-2">
                    {state.byPlatform[platform.key].map((asset) => (
                      <li key={asset.name}>
                        <a
                          href={asset.url}
                          className="font-mono text-xs text-ink underline decoration-hairline-strong underline-offset-4"
                        >
                          {asset.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="mt-6 font-mono text-xs text-muted">
              <a
                href={state.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="text-ink underline decoration-hairline-strong underline-offset-4"
              >
                {copy.common.download.allPlatforms}
              </a>
            </p>
          </div>
        ) : null}
      </Section>

      <Section tone="surface">
        <SectionHeading
          title={copy.download.buildFromSource.title}
          subtitle={copy.download.buildFromSource.body}
        />
        <ol className="mt-10 flex max-w-3xl flex-col gap-5">
          {copy.download.buildFromSource.steps.map((step, index) => (
            <li key={step.command}>
              <p className="font-mono text-xs uppercase tracking-widest text-muted">
                {format("{index}", { index: String(index + 1).padStart(2, "0") })} · {step.label}
              </p>
              <pre className="mt-2 overflow-x-auto rounded-control border border-hairline bg-paper px-4 py-3">
                <code className="font-mono text-sm text-ink">{step.command}</code>
              </pre>
            </li>
          ))}
        </ol>
      </Section>

      <Section tone="paper">
        <SectionHeading title={copy.download.requirements.title} />
        <ul className="mt-10 flex max-w-3xl flex-col">
          {copy.download.requirements.items.map((item) => (
            <li
              key={item}
              className="border-t border-hairline py-5 leading-relaxed text-muted first:border-t-0 first:pt-0"
            >
              {item}
            </li>
          ))}
        </ul>
      </Section>
    </SiteShell>
  )
}
