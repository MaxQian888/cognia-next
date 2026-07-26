import type { CommonCopy } from "@web/content/types"
import type { ReleaseState } from "@web/lib/evidence"
import type { Locale } from "@web/lib/locale"
import { REPO_URL } from "@web/lib/site"
import { SiteLink } from "./site-link"

interface DownloadCtaProps {
  locale: Locale
  copy: CommonCopy
  state: ReleaseState
  /** `hero` renders the explanatory note; `compact` is the navigation button. */
  variant?: "hero" | "compact"
  docsOrigin?: string
}

/**
 * The site's primary call to action (ADR-0092 §7).
 *
 * There is no published release yet, so the honest primary action is "build
 * from source" — and the note beneath says why, with a link to watch releases.
 * When a release does exist the same component becomes a download button. The
 * unavailable branch is the one that ships today, so it is the default path
 * rather than a fallback nobody exercises.
 *
 * Both branches point at `/download`, which carries the detail. The spec
 * forbids competing top-level CTAs, so "watch releases" is a note, not a third
 * button.
 */
export function DownloadCta({
  locale,
  copy,
  state,
  variant = "hero",
  docsOrigin,
}: DownloadCtaProps) {
  const label = state.hasRelease ? copy.download.available : copy.download.unavailable

  if (variant === "compact") {
    return (
      <SiteLink
        target={{ label, route: "/download" }}
        locale={locale}
        docsOrigin={docsOrigin}
        className="inline-flex items-center rounded-control bg-ink px-4 py-2 text-sm font-medium text-paper transition-opacity hover:opacity-90"
      />
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <SiteLink
          target={{ label, route: "/download" }}
          locale={locale}
          docsOrigin={docsOrigin}
          className="inline-flex items-center rounded-control bg-ink px-6 py-3 text-base font-medium text-paper transition-opacity hover:opacity-90"
        />
        <SiteLink
          target={{ label: copy.viewSource, href: REPO_URL }}
          locale={locale}
          docsOrigin={docsOrigin}
          className="inline-flex items-center rounded-control border border-hairline-strong px-6 py-3 text-base font-medium text-ink transition-colors hover:bg-surface"
        />
      </div>

      {state.hasRelease ? (
        <p className="font-mono text-xs text-muted">
          {copy.download.version} {state.version}
        </p>
      ) : (
        <p className="max-w-xl text-sm leading-relaxed text-muted">
          {copy.download.unavailableExplain}{" "}
          <a
            href={state.htmlUrl}
            target="_blank"
            rel="noreferrer"
            className="text-ink underline decoration-hairline-strong underline-offset-4 hover:decoration-ink"
          >
            {copy.download.unavailableSecondary}
          </a>
        </p>
      )}
    </div>
  )
}
