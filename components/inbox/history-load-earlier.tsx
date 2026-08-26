"use client"

/**
 * "Load earlier messages" bar for a platform conversation. Pulls a page of
 * older history from the bound adapter via `useHistoryHydration` and back-fills
 * it into the session. Desktop-only — rendered disabled in web mode since the
 * bus has no running adapters there.
 *
 * The same treatment now covers the capability itself. `history.fetch` is
 * undeclared on 7 of 11 platforms and can be suppressed on a Slack workspace
 * whose grant lacks `*:history`, and the conversation page used to answer that
 * by not mounting this bar at all — leaving "this chat has no earlier
 * messages", "the bot cannot read them", and "the page is broken" looking
 * identical. `unavailable` wins over the web-mode gate when both apply: it is
 * the more specific fact, and switching to the desktop app would not fix it.
 */

import { useTranslations } from "next-intl"
import { Loader2Icon, HistoryIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { CapabilityNotice } from "@/components/connectors/capability-notice"
import { useHistoryHydration } from "@/hooks/connectors/use-history-hydration"
import type { CapabilityUnavailable } from "@/lib/connectors/capability-availability"

export interface HistoryLoadEarlierProps {
  conversationKey: string
  adapterId: string
  /** Why this bot cannot fetch history, when it cannot. */
  unavailable?: CapabilityUnavailable
}

export function HistoryLoadEarlier({
  conversationKey,
  adapterId,
  unavailable,
}: HistoryLoadEarlierProps) {
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

  if (unavailable) {
    return (
      <div
        className="flex flex-wrap items-center justify-center gap-x-2 border-b px-3 py-1.5"
        data-testid="history-load-earlier-unavailable"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs text-muted-foreground"
          disabled
          aria-label={t("aria")}
        >
          <HistoryIcon className="h-3.5 w-3.5" />
          {t("button")}
        </Button>
        <CapabilityNotice availability={unavailable} className="text-[11px]" />
      </div>
    )
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
