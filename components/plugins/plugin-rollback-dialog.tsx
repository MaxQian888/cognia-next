"use client"

// Rollback dialog — surfaces `lib/plugin/lifecycle/rollback.ts` so the user
// can move a plugin back to a previous version (backup, marketplace, or
// local). The dialog reads the live `RollbackInfo` for the active plugin
// and renders one row per `VersionInfo`. Tauri runtime is required for the
// actual rollback call (`invoke` under the hood); outside Tauri we still
// surface the version list but disable the action with a hint.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { HistoryIcon, RotateCcwIcon } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  getPluginRollbackManager,
  type RollbackInfo,
  type RollbackResult,
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

export function PluginRollbackDialog({ open, pluginId, onClose }: Props) {
  const t = useTranslations("plugins.rollback")
  const [info, setInfo] = useState<RollbackInfo | null>(null)
  const [busyVersion, setBusyVersion] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tauri = isTauri()

  useEffect(() => {
    if (!open || !pluginId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null)
    void (async () => {
      try {
        const next = await getClient().getRollbackInfo(pluginId)
        setInfo(next)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })()
  }, [open, pluginId])

  const apply = async (version: string) => {
    if (!pluginId) return
    setBusyVersion(version)
    setError(null)
    try {
      const result = await getClient().rollback(pluginId, version)
      if (!result.success) {
        setError(result.error ?? t("rollbackFailed"))
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyVersion(null)
    }
  }

  const versions = info?.availableVersions ?? []
  const rollbackable = versions.filter((v) => v.canRollback)

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-[95vw] max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

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

        {error && <p className="text-xs text-destructive break-words">{error}</p>}

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
          <ScrollArea className="max-h-[40vh]">
            {versions.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground text-center">{t("empty")}</p>
            ) : (
              <ul className="divide-y">
                {versions.map((version) => (
                  <li
                    key={`${version.source}-${version.version}`}
                    className="flex items-start gap-2 px-3 py-2"
                  >
                    <HistoryIcon className="size-4 text-muted-foreground mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="text-xs">
                          v{version.version}
                        </Badge>
                        <Badge variant="secondary" className="text-xs">
                          {version.source}
                        </Badge>
                        {version.date && (
                          <span className="text-xs text-muted-foreground">
                            {new Date(version.date).toISOString().split("T")[0]}
                          </span>
                        )}
                      </div>
                      {version.reason && (
                        <p className="text-xs text-muted-foreground">{version.reason}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void apply(version.version)}
                      disabled={!version.canRollback || busyVersion !== null || !tauri}
                      aria-label={t("rollbackAria", { version: version.version })}
                    >
                      <RotateCcwIcon className="size-3.5 mr-1.5" />
                      {busyVersion === version.version ? t("rollingBack") : t("rollback")}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </Card>

        <DialogFooter>
          <Button onClick={onClose}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
