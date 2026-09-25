"use client"

/**
 * What every preview surface shows before an address has been committed.
 *
 * The embedded pane had this; the web fallback had nothing at all — a blank
 * area with an `src`-less iframe and no way in, on the shell where a local dev
 * server is the whole point of the feature.
 */

import { GlobeIcon, HistoryIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { historyLabel } from "@/components/browser/browser-history-menu"
import { Button } from "@/components/ui/button"

/** Common local dev-server addresses offered as one-click chips when empty. */
export const QUICK_OPEN_URLS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
] as const

/** How many recently visited pages the empty state offers. */
export const EMPTY_STATE_RECENT_LIMIT = 4

export function BrowserEmptyState({
  onOpen,
  recent = [],
}: {
  onOpen: (url: string) => void
  /**
   * Pages visited before, most recent first. A pane opened fresh used to offer
   * only three localhost ports, however often the user had come here for the
   * same few pages.
   */
  recent?: string[]
}) {
  const t = useTranslations("browser")
  const recentPages = recent.slice(0, EMPTY_STATE_RECENT_LIMIT)
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center animate-in fade-in duration-200"
      data-testid="browser-empty-state"
    >
      <div className="flex size-12 items-center justify-center rounded-stage bg-muted">
        <GlobeIcon className="size-6 text-muted-foreground" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("empty.title")}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{t("empty.hint")}</p>
      </div>
      {recentPages.length > 0 && (
        <div
          className="flex max-w-full flex-wrap items-center justify-center gap-2"
          data-testid="browser-empty-recent"
        >
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <HistoryIcon className="size-3.5" aria-hidden />
            {t("empty.recent")}
          </span>
          {recentPages.map((url) => (
            <Button
              key={url}
              size="sm"
              variant="secondary"
              className="h-7 max-w-full rounded-pill px-3 font-mono text-xs font-normal"
              title={url}
              onClick={() => onOpen(url)}
            >
              <span className="min-w-0 max-w-48 truncate">{historyLabel(url)}</span>
            </Button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <span className="text-xs text-muted-foreground">{t("empty.quickOpen")}</span>
        {QUICK_OPEN_URLS.map((url) => (
          <Button
            key={url}
            size="sm"
            variant="outline"
            className="h-7 rounded-pill px-3 font-mono text-xs font-normal"
            onClick={() => onOpen(url)}
          >
            {new URL(url).host}
          </Button>
        ))}
      </div>
    </div>
  )
}
