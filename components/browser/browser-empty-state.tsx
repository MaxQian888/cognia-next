"use client"

/**
 * What every preview surface shows before an address has been committed.
 *
 * The embedded pane had this; the web fallback had nothing at all — a blank
 * area with an `src`-less iframe and no way in, on the shell where a local dev
 * server is the whole point of the feature.
 */

import { GlobeIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"

/** Common local dev-server addresses offered as one-click chips when empty. */
export const QUICK_OPEN_URLS = [
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
] as const

export function BrowserEmptyState({ onOpen }: { onOpen: (url: string) => void }) {
  const t = useTranslations("browser")
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
