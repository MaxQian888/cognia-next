"use client"

// Rollback dialog — surfaces `lib/plugin/lifecycle/rollback.ts` so the user
// can move a plugin back to a previous version (backup, marketplace, or
// local). The dialog reads the live `RollbackInfo` for the active plugin
// and renders one row per `VersionInfo`. Tauri runtime is required for the
// actual rollback call (`invoke` under the hood); outside Tauri we still
// surface the version list but disable the action with a hint (the row menu
// only offers this dialog on the desktop shell with a backup to go back to).
//
// Rules this file holds:
//   - The info belongs to ONE plugin. It is fetched per `pluginId` and reset
//     the moment the target changes, so plugin B never opens on plugin A's
//     version list while B's request is in flight.
//   - While that request is in flight the dialog says so (it used to show the
//     "no snapshots" empty state, which is a claim, not a wait).
//   - Rolling back replaces the installed version, so it asks first.
//   - Dates are formatted for the user's locale, not sliced out of ISO.

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { HistoryIcon, RotateCcwIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { usePluginDisplayName } from "@/hooks/plugins/use-plugin-display-name"
import { notifyPluginBackupsChanged } from "@/hooks/plugins/use-plugin-rollback-availability"
import {
  getPluginRollbackManager,
  type RollbackInfo,
  type RollbackResult,
  type VersionInfo,
} from "@/lib/plugin/lifecycle/rollback"
import { isTauri } from "@/lib/tauri"

interface RollbackClient {
  getRollbackInfo: (pluginId: string) => Promise<RollbackInfo>
  rollback: (pluginId: string, targetVersion: string) => Promise<RollbackResult>
}

let cachedClient: RollbackClient | null = null

function getClient(): RollbackClient {
  if (cachedClient) return cachedClient
  const mgr = getPluginRollbackManager()
  cachedClient = {
    getRollbackInfo: (pluginId) => mgr.getRollbackInfo(pluginId),
    rollback: (pluginId, version) => mgr.rollback(pluginId, version),
  }
  return cachedClient
}

export function __resetPluginRollbackClientForTests(client: RollbackClient | null) {
  cachedClient = client
}

interface Props {
  open: boolean
  pluginId: string | null
  onClose: () => void
}

/** Info tagged with the plugin it was fetched for. */
interface LoadedInfo {
  pluginId: string
  info: RollbackInfo
}

export function PluginRollbackDialog({ open, pluginId, onClose }: Props) {
  const t = useTranslations("plugins.rollback")
  const pluginName = usePluginDisplayName(pluginId)
  const [loaded, setLoaded] = useState<LoadedInfo | null>(null)
  const [loadError, setLoadError] = useState<{ pluginId: string; message: string } | null>(null)
  const [busyVersion, setBusyVersion] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirmVersion, setConfirmVersion] = useState<VersionInfo | null>(null)
  const tauri = isTauri()

  // Reset per-target state when the target changes (the documented
  // prev-value compare, not an effect).
  const [trackedPluginId, setTrackedPluginId] = useState(pluginId)
  if (trackedPluginId !== pluginId) {
    setTrackedPluginId(pluginId)
    setActionError(null)
    setConfirmVersion(null)
  }

  useEffect(() => {
    if (!open || !pluginId) return
    let cancelled = false
    void (async () => {
      try {
        const next = await getClient().getRollbackInfo(pluginId)
        if (!cancelled) setLoaded({ pluginId, info: next })
      } catch (err) {
        if (!cancelled) {
          setLoadError({ pluginId, message: err instanceof Error ? err.message : String(err) })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, pluginId])

  // Only ever render info for the plugin being asked about.
  const info = loaded && loaded.pluginId === pluginId ? loaded.info : null
  const loadErrorMessage = loadError && loadError.pluginId === pluginId ? loadError.message : null
  const loading = open && pluginId !== null && info === null && loadErrorMessage === null
  const error = actionError ?? loadErrorMessage

  const apply = async (version: string) => {
    if (!pluginId) return
    setBusyVersion(version)
    setActionError(null)
    try {
      const result = await getClient().rollback(pluginId, version)
      if (!result.success) {
        setActionError(result.error ?? t("rollbackFailed"))
        return
      }
      // A rollback writes backups of its own; the row menus re-check.
      notifyPluginBackupsChanged()
      onClose()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyVersion(null)
    }
  }

  const versions = info?.availableVersions ?? []
  const rollbackable = versions.filter((v) => v.canRollback)

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex max-h-[85dvh] w-[95vw] max-w-xl min-w-0 flex-col">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div
            className="-mx-1 min-h-0 flex-1 space-y-3 overflow-y-auto px-1"
            data-testid="plugin-rollback-body"
          >
            {info && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant="secondary">
                  {t("currentVersion", { version: info.currentVersion })}
                </Badge>
                {info.hasBackups && (
                  <Badge variant="outline">{t("hasBackups", { count: versions.length })}</Badge>
                )}
              </div>
            )}

            {error && (
              <p className="text-xs text-destructive break-words" role="alert">
                {error}
              </p>
            )}

            {!tauri && (
              <Card className="p-3 border-amber-500/50">
                <p className="text-xs text-muted-foreground">{t("desktopOnlyHint")}</p>
              </Card>
            )}

            {versions.length > 0 && rollbackable.length === 0 && (
              <Card className="p-3 border-destructive/50">
                <p className="text-xs text-destructive">{t("canNotRollback")}</p>
              </Card>
            )}

            <Card className="p-0">
              {loading ? (
                <div
                  className="space-y-2 p-3"
                  role="status"
                  aria-busy="true"
                  data-testid="plugin-rollback-loading"
                >
                  <span className="sr-only">{t("loading")}</span>
                  <Skeleton className="h-8 w-full" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ) : versions.length === 0 ? (
                loadErrorMessage ? null : (
                  <p className="p-4 text-sm text-muted-foreground text-center">{t("empty")}</p>
                )
              ) : (
                <ul className="divide-y">
                  {versions.map((version) => (
                    <li
                      key={`${version.source}-${version.version}`}
                      className="flex flex-wrap items-start gap-2 px-3 py-2"
                    >
                      <HistoryIcon
                        className="size-4 text-muted-foreground mt-0.5 shrink-0"
                        aria-hidden="true"
                      />
                      <div className="flex-1 min-w-0 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-xs">
                            v{version.version}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {t(`source.${version.source}` as never)}
                          </Badge>
                          {version.date && <VersionDate date={version.date} />}
                        </div>
                        {version.reason && (
                          <p className="text-xs text-muted-foreground break-words">
                            {version.reason}
                          </p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="pointer-coarse:h-9"
                        onClick={() => setConfirmVersion(version)}
                        disabled={!version.canRollback || busyVersion !== null || !tauri}
                        aria-label={t("rollbackAria", { version: version.version })}
                      >
                        <RotateCcwIcon className="size-3.5 mr-1.5" aria-hidden="true" />
                        {busyVersion === version.version ? t("rollingBack") : t("rollback")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <DialogFooter className="shrink-0">
            <Button onClick={onClose}>{t("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rolling back REPLACES the installed version (and restarts the plugin
          on it), so the row button only asks; this is where it happens. */}
      <AlertDialog
        open={confirmVersion !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmVersion(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("confirmTitle", { version: confirmVersion?.version ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("confirmBody", {
                name: pluginName,
                from: info?.currentVersion ?? "",
                to: confirmVersion?.version ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const target = confirmVersion
                setConfirmVersion(null)
                if (target) void apply(target.version)
              }}
            >
              {t("confirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * Locale-formatted snapshot date. Its own component so the formatter is only
 * touched when a version list is actually on screen (the dialog is mounted,
 * closed, on every `/plugins` render).
 */
function VersionDate({ date }: { date: Date | string | number }) {
  const format = useFormatter()
  const value = new Date(date)
  if (Number.isNaN(value.getTime())) return null
  return (
    <time className="text-xs text-muted-foreground" dateTime={value.toISOString()}>
      {format.dateTime(value, { dateStyle: "medium" })}
    </time>
  )
}
