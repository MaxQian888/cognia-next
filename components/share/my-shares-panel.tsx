"use client"

// Lists the share links the owner created (local Dexie mirror) with copy /
// open / revoke. Revoking calls the worker DELETE and flips the local row.

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CalendarClockIcon,
  ExternalLinkIcon,
  EyeIcon,
  MessageSquareIcon,
  PaperclipIcon,
  Trash2Icon,
} from "lucide-react"
import { CopyFeedbackIcon } from "@/components/shared/animated-action-icon"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { getSessionsByIds } from "@/lib/db/sessions"
import { listSharedLinks } from "@/lib/db/shared-links"
import { formatBytes } from "@/lib/perf/backend/format"
import { revokeShareLink, getShareStats } from "@/lib/share/client"
import { extendShareLink } from "@/lib/share/renew"
import { toast } from "sonner"
import { createLogger } from "@cognia/logging"

const log = createLogger("my-shares")

export function MySharesPanel() {
  const t = useTranslations("share.myShares")
  // Reactive: revoking a link flips its Dexie row and this list re-renders.
  const rows = useLiveQuery(() => listSharedLinks(), [])
  // The conversations links came from (ADR-0222), looked up by id so a
  // renamed conversation reads as it is now and a deleted one says so.
  const sourceKey = [...new Set(rows?.flatMap((row) => (row.sessionId ? [row.sessionId] : [])))]
    .sort()
    .join("\n")
  const sourceTitles = useLiveQuery(async () => {
    const ids = sourceKey ? sourceKey.split("\n") : []
    const sessions = await getSessionsByIds(ids)
    return new Map(sessions.map((session) => [session.id, session.title]))
  }, [sourceKey])
  const [revoking, setRevoking] = useState<string | null>(null)
  const [renewing, setRenewing] = useState<string | null>(null)
  // Lazily fetched per-link view counts (avoid N network calls on mount).
  const [views, setViews] = useState<Record<string, number>>({})
  const [loadingStats, setLoadingStats] = useState<string | null>(null)
  const [copiedCode, setCopiedCode] = useState<string | null>(null)
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
    },
    []
  )

  const onCopy = async (url: string, code: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedCode(code)
      if (copyResetRef.current) clearTimeout(copyResetRef.current)
      copyResetRef.current = setTimeout(() => setCopiedCode(null), 1500)
      toast.success(t("copy"))
    } catch (err) {
      log.error("copy-failed", { error: err instanceof Error ? err.message : String(err) })
    }
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

  // Request at least a week from now. The server preserves a later expiry
  // and clamps the requested window to its configured ceiling.
  const RENEW_SECONDS = 7 * 24 * 60 * 60
  const onRenew = async (code: string) => {
    setRenewing(code)
    try {
      const expiresAt = await extendShareLink(code, RENEW_SECONDS)
      toast.success(
        expiresAt !== undefined
          ? t("renewed", { date: new Date(expiresAt).toLocaleString() })
          : t("renewedUnknown")
      )
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
                {row.expiresAt ? new Date(row.expiresAt).toLocaleString() : t("expiryUnavailable")}
              </p>
              {row.files?.length || row.sessionId ? (
                <p className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  {row.files?.length ? (
                    <span className="inline-flex items-center gap-1">
                      <PaperclipIcon className="size-3" aria-hidden />
                      {t("files", {
                        count: row.files.length,
                        size: formatBytes(row.files.reduce((sum, file) => sum + file.size, 0)),
                      })}
                    </span>
                  ) : null}
                  {row.sessionId && sourceTitles ? (
                    <span className="inline-flex min-w-0 items-center gap-1">
                      <MessageSquareIcon className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">
                        {sourceTitles.has(row.sessionId)
                          ? t("fromConversation", {
                              title: sourceTitles.get(row.sessionId) || t("untitledConversation"),
                            })
                          : t("fromDeletedConversation")}
                      </span>
                    </span>
                  ) : null}
                </p>
              ) : null}
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
              onClick={() => void onCopy(row.url, row.code)}
            >
              <CopyFeedbackIcon copied={copiedCode === row.code} size={16} />
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
