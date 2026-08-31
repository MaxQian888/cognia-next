"use client"

/**
 * Control for the in-app plugin file watcher (`lib/plugin/devtools/file-watch`).
 *
 * Every plugin is listed, watched or not, with the reason it is not. A card
 * that showed only the watched ones would make "your plugin needs a build
 * first" look identical to "the watcher is broken", which is the state this
 * whole area was in before.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { EyeIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { PluginEmptyState } from "@/components/plugins/_shared/plugin-empty-state"
import { isTauri } from "@/lib/tauri"
import {
  startPluginFileWatch,
  watchEligibility,
  type PluginFileWatchHandle,
  type WatchIneligibility,
} from "@/lib/plugin/devtools/file-watch"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { cn } from "@/lib/utils"

export function PluginWatchCard({ className }: { className?: string }) {
  const t = useTranslations("plugins.devtools.watch")
  const pluginMap = usePluginStore((state) => state.plugins)
  const plugins = useMemo(() => Object.values(pluginMap), [pluginMap])
  const desktop = isTauri()
  const [enabled, setEnabled] = useState(false)
  const [watchedIds, setWatchedIds] = useState<string[]>([])
  const handleRef = useRef<PluginFileWatchHandle | null>(null)

  const rows = useMemo(
    () =>
      plugins
        .map((plugin) => ({
          id: plugin.manifest.id,
          name: plugin.manifest.name,
          eligibility: watchEligibility(plugin, desktop),
        }))
        .sort((a, b) => Number(b.eligibility.watchable) - Number(a.eligibility.watchable)),
    [plugins, desktop]
  )
  const eligible = rows.filter((row) => row.eligibility.watchable)
  const skipped = rows.filter((row) => !row.eligibility.watchable)

  const stop = useCallback(async () => {
    const handle = handleRef.current
    handleRef.current = null
    await handle?.stop()
  }, [])

  // Starting and stopping is a user action, not derived state, so it happens
  // in the handler. An effect would have to reset state during render-phase
  // teardown and would re-run on every unrelated plugin-store write, tearing
  // the native watcher down and back up each time.
  const toggle = useCallback(
    async (next: boolean) => {
      setEnabled(next)
      if (!next) {
        setWatchedIds([])
        await stop()
        return
      }
      try {
        const handle = await startPluginFileWatch(Object.values(usePluginStore.getState().plugins))
        handleRef.current = handle
        setWatchedIds(handle.watchedPluginIds)
      } catch (error) {
        setEnabled(false)
        setWatchedIds([])
        toast.error(
          t("startFailed", { message: error instanceof Error ? error.message : String(error) })
        )
      }
    },
    [stop, t]
  )

  // Releasing the native watcher is the whole point of unmount cleanup here:
  // the Rust side holds a `notify` watcher until it is told to stop.
  useEffect(() => () => void handleRef.current?.stop(), [])

  return (
    <Card
      className={cn("gap-0 overflow-hidden border-border/70 py-0 shadow-sm", className)}
      data-testid="plugin-watch-card"
    >
      <div className="flex h-full flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
              <EyeIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-1">
              <h3 className="truncate text-sm font-semibold tracking-tight">{t("title")}</h3>
              <p className="text-xs text-muted-foreground">{t("description")}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Label htmlFor="plugin-watch-toggle" className="sr-only">
              {t("toggleLabel")}
            </Label>
            <Switch
              id="plugin-watch-toggle"
              checked={enabled}
              onCheckedChange={(next) => void toggle(next)}
              disabled={!desktop || eligible.length === 0}
              aria-label={t("toggleLabel")}
            />
          </div>
        </div>

        {!desktop ? (
          <p className="text-xs text-muted-foreground" data-testid="plugin-watch-desktop-only">
            {t("desktopOnly")}
          </p>
        ) : eligible.length === 0 ? (
          <PluginEmptyState
            icon={<EyeIcon className="size-5" />}
            hint={t("empty")}
            className="min-h-24 gap-2 bg-muted/15 p-4 md:p-4 [&_[data-slot=empty-header]]:gap-1.5 [&_[data-slot=empty-icon]]:mb-0 [&_[data-slot=empty-title]]:text-base"
            dataTestId="plugin-watch-empty"
          />
        ) : (
          <p className="text-xs text-muted-foreground" data-testid="plugin-watch-status">
            {enabled ? t("watching", { count: watchedIds.length }) : t("idle")}
          </p>
        )}

        {skipped.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-muted-foreground">{t("skippedHeading")}</h4>
            <ul className="space-y-1.5">
              {skipped.map((row) => (
                <li
                  key={row.id}
                  className="rounded-md border bg-card px-2.5 py-1.5 text-xs"
                  data-testid={`plugin-watch-skipped-${row.id}`}
                  data-reason={row.eligibility.watchable ? undefined : row.eligibility.reason}
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{row.name}</span>
                    <Badge variant="outline" className="shrink-0 text-[10px]">
                      {row.id}
                    </Badge>
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {!row.eligibility.watchable && t(`reason.${row.eligibility.reason}` as never)}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

/** Re-exported so the catalogue test can enumerate every reason it renders. */
export const WATCH_INELIGIBILITY_REASONS: WatchIneligibility[] = [
  "needs-build",
  "not-local-source",
  "desktop-required",
]
