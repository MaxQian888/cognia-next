"use client"

/**
 * "Load earlier messages" bar for a platform conversation. Pulls a page of
 * older history from the bound adapter via `useHistoryHydration` and back-fills
 * it into the session. Desktop-only — rendered disabled in web mode since the
 * bus has no running adapters there.
 */

import { useTranslations } from "next-intl"
import { Loader2Icon, HistoryIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useHistoryHydration } from "@/hooks/connectors/use-history-hydration"

export interface HistoryLoadEarlierProps {
  conversationKey: string
  adapterId: string
}

export function HistoryLoadEarlier({ conversationKey, adapterId }: HistoryLoadEarlierProps) {
  const t = useTranslations("inbox.loadEarlier")
  const { hydrate, hydrating, canHydrate, lastCount, error } = useHistoryHydration(
    conversationKey,
    adapterId
  )

  const handleClick = async () => {
    const count = await hydrate()
    if (count > 0) {
      toast.success(t("loaded", { count }))
    } else if (!hydrating) {
      toast.info(t("none"))
    }
  }

  return (
    <div className="flex items-center justify-center border-b px-3 py-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 text-xs text-muted-foreground"
        onClick={handleClick}
        disabled={!canHydrate || hydrating}
        aria-label={t("aria")}
        title={canHydrate ? undefined : t("desktopOnly")}
      >
        {hydrating ? (
          <Loader2Icon className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <HistoryIcon className="h-3.5 w-3.5" />
        )}
        {hydrating ? t("loading") : t("button")}
      </Button>
      {error === "failed" && (
        <span className="ml-2 text-xs text-destructive" role="status">
          {t("error")}
        </span>
      )}
      {lastCount === 0 && error === null && !hydrating && (
        <span className="ml-2 text-xs text-muted-foreground" role="status">
          {t("none")}
        </span>
      )}
    </div>
  )
}
