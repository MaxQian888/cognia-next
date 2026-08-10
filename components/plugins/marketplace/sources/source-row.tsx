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
import { AlertTriangleIcon, ExternalLinkIcon, RefreshCwIcon, Trash2Icon } from "lucide-react"

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
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Item, ItemActions, ItemContent, ItemFooter, ItemHeader } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

import type { MarketplaceSourceItem } from "./types"

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
    <Item
      variant="outline"
      size="sm"
      className="items-stretch gap-1.5"
      data-testid={`marketplace-source-${source.id}`}
    >
      <ItemHeader>
        <ItemContent className="min-w-0">
          <div className="truncate text-sm font-medium">{source.name}</div>
          <div className="truncate font-mono text-xs text-muted-foreground">{source.repoRef}</div>
          <Badge
            variant={sync.kind === "error" ? "destructive" : "outline"}
            className="w-fit max-w-full gap-1 text-xs"
            data-testid={`marketplace-source-status-${sync.kind}`}
          >
            {sync.kind === "syncing" && <Spinner className="size-3" />}
            <span className="truncate">{statusLine}</span>
          </Badge>
        </ItemContent>

        <ItemActions className="gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label={t("refreshSource", { name: source.name })}
            disabled={syncing}
            onClick={() => onRefresh(source.id)}
          >
            {syncing ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
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
        </ItemActions>
      </ItemHeader>

      {sync.kind === "error" && (
        <ItemFooter>
          <Alert variant="destructive" className="py-2">
            <AlertTriangleIcon aria-hidden />
            <AlertDescription className="flex min-w-0 flex-row items-center justify-between gap-2">
              <span className="truncate text-xs">{sync.message}</span>
              <Button
                variant="outline"
                size="xs"
                className="shrink-0"
                onClick={() => onRefresh(source.id)}
              >
                {t("retry")}
              </Button>
            </AlertDescription>
          </Alert>
        </ItemFooter>
      )}
      {sync.kind === "error" && lastSyncedAt !== undefined && (
        <ItemFooter>
          <p className="text-xs text-muted-foreground">
            {t("syncedAt", { time: format.relativeTime(new Date(lastSyncedAt), now) })}
          </p>
        </ItemFooter>
      )}
    </Item>
  )
}
