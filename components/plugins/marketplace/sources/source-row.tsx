"use client"

// One saved marketplace source, with its sync health.
//
// The health line exists because `useGithubMarketplaceSources` already
// computes `errors` and `loading` and nothing rendered them: a repo that was
// renamed, rate-limited, or shipped broken JSON simply contributed zero
// plugins to the browse grid, silently. A source that failed to sync now says
// so on its own row and offers the retry.
//
// Removal is confirmed, and the confirmation states the one thing a user can't
// infer: plugins already installed from this source are not uninstalled.

import { useTranslations, useFormatter, useNow } from "next-intl"
import { ExternalLinkIcon, Loader2Icon, RefreshCwIcon, Trash2Icon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

import type { MarketplaceSourceItem, SourceSyncState } from "./types"

const DOT_CLASS: Record<SourceSyncState["kind"], string> = {
  ok: "bg-emerald-500",
  error: "bg-destructive",
  syncing: "bg-muted-foreground animate-pulse",
  never: "bg-muted-foreground/40",
}

interface Props {
  source: MarketplaceSourceItem
  onRefresh: (id: string) => void
  onRemove: (id: string) => void
  onOpenRepo: (url: string) => void
}

export function PluginMarketplaceSourceRow({ source, onRefresh, onRemove, onOpenRepo }: Props) {
  const t = useTranslations("plugins.marketplaceSources")
  const format = useFormatter()
  // `relativeTime` without an explicit `now` raises next-intl's
  // ENVIRONMENT_FALLBACK error and silently reads the wall clock. Pinning it to
  // `useNow()` also keeps every row on the same reference instant, so two
  // sources synced together can't render as "2 minutes ago" and "3 minutes ago".
  const now = useNow()
  const { sync } = source
  const syncing = sync.kind === "syncing"

  const lastSyncedAt =
    sync.kind === "ok" ? sync.lastSyncedAt : sync.kind === "error" ? sync.lastSyncedAt : undefined

  const statusLine = (() => {
    switch (sync.kind) {
      case "syncing":
        return t("syncing")
      case "never":
        return t("neverSynced")
      case "error":
        return t("syncFailed")
      case "ok":
        return `${t("pluginCount", { count: sync.pluginCount })} · ${t("syncedAt", {
          time: format.relativeTime(new Date(sync.lastSyncedAt), now),
        })}`
    }
  })()

  return (
    <Card className="p-2.5 gap-0 space-y-1.5" data-testid={`marketplace-source-${source.id}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <span
            className={cn("size-1.5 rounded-full mt-1.5 shrink-0", DOT_CLASS[sync.kind])}
            aria-hidden="true"
            data-testid={`marketplace-source-status-${sync.kind}`}
          />
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{source.name}</div>
            <div className="text-xs text-muted-foreground font-mono truncate">{source.repoRef}</div>
            <div
              className={cn(
                "text-xs",
                sync.kind === "error" ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {statusLine}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("refreshSource", { name: source.name })}
            disabled={syncing}
            onClick={() => onRefresh(source.id)}
          >
            {syncing ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("openOnGithub")}
            onClick={() => onOpenRepo(source.repoUrl)}
          >
            <ExternalLinkIcon className="size-3.5" />
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("remove", { name: source.name })}
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("removeTitle", { name: source.name })}</AlertDialogTitle>
                <AlertDialogDescription>{t("removeDescription")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => onRemove(source.id)}>
                  {t("removeConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {sync.kind === "error" && (
        <div className="flex items-center justify-between gap-2 pl-3.5">
          <p className="text-xs text-destructive truncate" role="alert">
            {sync.message}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs shrink-0"
            onClick={() => onRefresh(source.id)}
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {sync.kind === "error" && lastSyncedAt !== undefined && (
        <p className="text-xs text-muted-foreground pl-3.5">
          {t("syncedAt", { time: format.relativeTime(new Date(lastSyncedAt), now) })}
        </p>
      )}
    </Card>
  )
}
