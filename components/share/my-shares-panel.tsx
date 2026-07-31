"use client"

// Lists the share links the owner created (local Dexie mirror) with copy /
// open / revoke. Revoking calls the worker DELETE and flips the local row.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CalendarClockIcon, CopyIcon, ExternalLinkIcon, EyeIcon, Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { listSharedLinks } from "@/lib/db/shared-links"
import { revokeShareLink, getShareStats } from "@/lib/share/client"
import { extendShareLink } from "@/lib/share/renew"
import { toast } from "sonner"
import { createLogger } from "@cognia/logging"

const log = createLogger("my-shares")

export function MySharesPanel() {
  const t = useTranslations("share.myShares")
  // Reactive: revoking a link flips its Dexie row and this list re-renders.
  const rows = useLiveQuery(() => listSharedLinks(), [])
  const [revoking, setRevoking] = useState<string | null>(null)
  const [renewing, setRenewing] = useState<string | null>(null)
  // Lazily fetched per-link view counts (avoid N network calls on mount).
  const [views, setViews] = useState<Record<string, number>>({})
  const [loadingStats, setLoadingStats] = useState<string | null>(null)

  const onCopy = async (url: string) => {
    await navigator.clipboard.writeText(url)
    toast.success(t("copy"))
  }

  const onStats = async (code: string) => {
    setLoadingStats(code)
    try {
      const stats = await getShareStats(code)
      if (stats) setViews((prev) => ({ ...prev, [code]: stats.viewCount }))
      else toast.error(t("statsError"))
    } catch (err) {
      log.error("stats-failed", { error: err instanceof Error ? err.message : String(err) })
      toast.error(t("statsError"))
    } finally {
      setLoadingStats(null)
    }
  }

  // Extend a link's lifetime to a week from now (the worker clamps to its
  // hard ceiling). A fresh window is simpler than "add N days" and matches the
  // worker's set-from-now semantics.
  const RENEW_SECONDS = 7 * 24 * 60 * 60
  const onRenew = async (code: string) => {
    setRenewing(code)
    try {
      const expiresAt = await extendShareLink(code, RENEW_SECONDS)
      toast.success(t("renewed", { date: new Date(expiresAt).toLocaleDateString() }))
    } catch (err) {
      log.error("renew-failed", { error: err instanceof Error ? err.message : String(err) })
      toast.error(t("renewError"))
    } finally {
      setRenewing(null)
    }
  }

  const onRevoke = async (code: string) => {
    setRevoking(code)
    try {
      await revokeShareLink(code)
    } catch (err) {
      log.error("revoke-failed", { error: err instanceof Error ? err.message : String(err) })
    } finally {
      setRevoking(null)
    }
  }

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {rows && rows.length === 0 && <p className="text-sm text-muted-foreground">{t("empty")}</p>}

      <ul className="space-y-2">
        {rows?.map((row) => (
          <li key={row.code} className="flex items-center gap-2 rounded-md border p-3">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {row.title || t(`kind.${row.kind}`)}
                </span>
                <Badge variant="secondary" className="shrink-0 text-[10px]">
                  {t(`kind.${row.kind}`)}
                </Badge>
                {row.burnAfterRead && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t("burnBadge")}
                  </Badge>
                )}
                {row.hasPassphrase && (
                  <Badge variant="outline" className="shrink-0 text-[10px]">
                    {t("passphraseBadge")}
                  </Badge>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t("created")}: {new Date(row.createdAt).toLocaleString()} · {t("expires")}:{" "}
                {row.expiresAt ? new Date(row.expiresAt).toLocaleString() : t("never")}
              </p>
            </div>
            {views[row.code] !== undefined ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("views", { count: views[row.code] })}
              </span>
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("viewsAction")}
                disabled={loadingStats === row.code}
                onClick={() => void onStats(row.code)}
              >
                <EyeIcon className="size-4" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("copy")}
              onClick={() => void onCopy(row.url)}
            >
              <CopyIcon className="size-4" />
            </Button>
            <Button asChild variant="ghost" size="icon" aria-label={t("open")}>
              <a href={row.url} target="_blank" rel="noreferrer">
                <ExternalLinkIcon className="size-4" />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("renew")}
              disabled={renewing === row.code}
              onClick={() => void onRenew(row.code)}
            >
              <CalendarClockIcon className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("revoke")}
              disabled={revoking === row.code}
              onClick={() => void onRevoke(row.code)}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
