import { Button } from "@web/components/ui/button"
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
      <Button asChild size="md">
        <SiteLink target={{ label, route: "/download" }} locale={locale} docsOrigin={docsOrigin} />
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {/* The two primary calls to action are what the pointer ring sights.
         * Marking every link would make the effect noise; marking the decisions
         * makes it an affordance.
         *
         * The attribute goes on a wrapper rather than on `Button asChild`:
         * `SiteLink` has a closed prop interface and does not spread unknown
         * props, so an attribute handed to it through Slot is silently dropped
         * and the feature ships dormant. The wrapper is `inline-flex` so its box
         * is exactly the button's. */}
        <span data-magnetic className="inline-flex">
          <Button asChild size="lg">
            <SiteLink
              target={{ label, route: "/download" }}
              locale={locale}
              docsOrigin={docsOrigin}
            />
          </Button>
        </span>
        <span data-magnetic className="inline-flex">
          <Button asChild variant="outline" size="lg">
            <SiteLink
              target={{ label: copy.viewSource, href: REPO_URL }}
              locale={locale}
              docsOrigin={docsOrigin}
            />
          </Button>
        </span>
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
