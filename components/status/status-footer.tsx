"use client"

/**
 * Footer: the subscription call to action, feed and mirror links, and the
 * statement of what this page does and does not monitor (plan §1 bounds).
 */

import { useTranslations } from "next-intl"
import { BellIcon, RssIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  statusApiUrl,
  validateStatusUrl,
  type StatusCapabilities,
  type StatusRuntime,
} from "@/lib/status/public-status"

import { StatusExternalLink } from "./status-link"

export function StatusFooter({
  runtime,
  capabilities,
  onSubscribe,
}: {
  runtime: StatusRuntime
  capabilities: StatusCapabilities | null
  onSubscribe: () => void
}) {
  const t = useTranslations("publicStatus")
  // Only HTTPS links leave the page; a malformed URL is dropped, not shown.
  const mirrorUrl = capabilities?.mirrorUrl ? validateStatusUrl(capabilities.mirrorUrl) : null
  const feeds = capabilities?.feeds === true

  return (
    <footer className="pb-10 md:pb-14">
      <div className="relative overflow-hidden rounded-3xl bg-foreground py-10 text-background shadow-sm md:py-14">
        <div
          aria-hidden
          className="absolute right-0 bottom-0 size-80 translate-x-1/3 translate-y-1/3 rounded-full bg-[radial-gradient(circle,color-mix(in_oklch,var(--chart-2)_38%,transparent),transparent_68%)] blur-2xl"
        />
        <div className="relative flex flex-col items-start justify-between gap-8 px-5 md:flex-row md:items-end md:px-10">
          <div className="max-w-2xl">
            <p className="text-sm text-background/60">{t("footer.eyebrow")}</p>
            <h2 className="mt-3 max-w-2xl text-balance text-3xl font-semibold tracking-tight md:text-5xl">
              {t("footer.title")}
            </h2>
            <p className="mt-4 text-background/65">{t("footer.description")}</p>
          </div>
          <Button
            variant="secondary"
            size="lg"
            className="bg-background text-foreground hover:bg-background/90"
            onClick={onSubscribe}
          >
            <BellIcon aria-hidden />
            {t("nav.subscribe")}
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-8 rounded-2xl border bg-card p-5 shadow-xs sm:p-6 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="max-w-3xl space-y-3 text-sm leading-6 text-muted-foreground">
          <h2 className="font-medium text-foreground">{t("footer.boundariesTitle")}</h2>
          <p data-testid="status-boundaries">{t("footer.boundaries")}</p>
          <p>{t("footer.measurement")}</p>
        </div>
        <nav aria-label={t("footer.links")} className="text-sm md:border-l md:pl-8">
          <ul className="space-y-2.5">
            {feeds ? (
              <>
                <li className="flex items-center gap-2">
                  <RssIcon className="size-4 text-muted-foreground" aria-hidden />
                  <StatusExternalLink
                    href={statusApiUrl(runtime.apiBase, "/feed.atom")}
                    mode={runtime.mode}
                  >
                    {t("feeds.atom")}
                  </StatusExternalLink>
                </li>
                <li className="flex items-center gap-2">
                  <RssIcon className="size-4 text-muted-foreground" aria-hidden />
                  <StatusExternalLink
                    href={statusApiUrl(runtime.apiBase, "/feed.rss")}
                    mode={runtime.mode}
                  >
                    {t("feeds.rss")}
                  </StatusExternalLink>
                </li>
              </>
            ) : null}
            {runtime.mode !== "primary" ? (
              <li>
                <StatusExternalLink href={runtime.primaryPageUrl} mode={runtime.mode}>
                  {t("footer.primary")}
                </StatusExternalLink>
              </li>
            ) : null}
            {mirrorUrl && runtime.mode !== "mirror" ? (
              <li>
                <StatusExternalLink href={mirrorUrl} mode={runtime.mode}>
                  {t("footer.mirror")}
                </StatusExternalLink>
              </li>
            ) : null}
          </ul>
        </nav>
      </div>
      <p className="mt-6 flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="grid size-5 place-items-center rounded-md bg-foreground text-[10px] font-semibold text-background"
        >
          {t("brandMark")}
        </span>
        {t("brand")}
      </p>
    </footer>
  )
}
