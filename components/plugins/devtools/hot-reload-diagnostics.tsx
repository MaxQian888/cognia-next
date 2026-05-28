"use client"

/**
 * Hot-reload activity panel for the plugin DevTools pane. Renders the
 * session-scoped history captured by `use-cli-bridge-events` into the
 * `hot-reload-history-store` — one row per install / uninstall /
 * hot-reload event the CLI bridge fired this launch.
 *
 * Purely a read surface over the store; the subscription + dedupe live
 * in the bridge-events hook so this panel works in tests by seeding the
 * store directly.
 */

import { useTranslations } from "next-intl"
import { RotateCwIcon, CheckIcon, XIcon, Loader2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { PluginEmptyState } from "@/components/plugins/_shared/plugin-empty-state"
import {
  useHotReloadHistoryStore,
  type HotReloadEntry,
  type HotReloadStatus,
} from "@/stores/plugin-runtime/hot-reload-history-store"

export function HotReloadDiagnostics({ className }: { className?: string }) {
  const t = useTranslations("plugins.devtools.hotReload")
  const entries = useHotReloadHistoryStore((s) => s.entries)
  const clear = useHotReloadHistoryStore((s) => s.clear)

  return (
    <Card className={className}>
      <div className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          {entries.length > 0 && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => clear()}
              data-testid="hot-reload-clear"
            >
              {t("clear")}
            </Button>
          )}
        </div>

        {entries.length === 0 ? (
          <PluginEmptyState
            icon={<RotateCwIcon className="size-5" />}
            hint={t("empty")}
            dataTestId="hot-reload-empty"
          />
        ) : (
          <ul className="space-y-1.5" data-testid="hot-reload-list">
            {entries.map((entry, i) => (
              <HotReloadRow key={`${entry.pluginId}-${entry.timestamp}-${i}`} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    </Card>
  )
}

function HotReloadRow({ entry }: { entry: HotReloadEntry }) {
  const t = useTranslations("plugins.devtools.hotReload")
  const kindLabel =
    entry.kind === "install"
      ? t("kindInstall")
      : entry.kind === "uninstall"
        ? t("kindUninstall")
        : t("kindHotReload")
  return (
    <li
      className="flex items-center justify-between gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs"
      data-testid={`hot-reload-row-${entry.pluginId}`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <StatusIcon status={entry.status} />
        <span className="truncate font-mono">{entry.pluginId}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        <Badge variant="outline" className="text-[10px]">
          {kindLabel}
        </Badge>
        <span className="tabular-nums">{formatTime(entry.timestamp)}</span>
      </div>
    </li>
  )
}

function StatusIcon({ status }: { status: HotReloadStatus }) {
  if (status === "success") {
    return <CheckIcon className="size-3.5 shrink-0 text-emerald-600" aria-hidden="true" />
  }
  if (status === "failed") {
    return <XIcon className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
  }
  return <Loader2Icon className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
}

function formatTime(ms: number): string {
  // Local wall-clock HH:MM:SS — diagnostics surface, so a relative or
  // localized format would add noise without value.
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
