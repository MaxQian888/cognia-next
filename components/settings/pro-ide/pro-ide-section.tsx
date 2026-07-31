"use client"

// Settings surface for the Pro IDE (embedded code-server) *install*.
//
// Running instances are not managed here — every cognia-spawned child process
// lives in the performance panel's Managed Processes tab, code-server included
// (`src-tauri/src/process_registry`). This card owns what that tab cannot show:
// the pinned version, the on-disk footprint, pre-fetching the ~100-200MB
// tarball before the first switch, and reclaiming space afterwards.

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, Loader2Icon, RotateCwIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  CODESERVER_EVENTS,
  type CodeServerDiskUsage,
  type CodeServerDownloadProgress,
  codeServerClient,
} from "@/lib/codeserver/client"
import { destroyCodeServerPane } from "@/lib/codeserver/pane-manager"
import { formatBytes } from "@/lib/perf/backend/format"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

type Busy = "download" | "clean" | "uninstall" | null

export function ProIdeSection() {
  const t = useTranslations("settings.proIde")
  // Outside the desktop shell there is nothing to probe — settle it up front
  // rather than round-tripping through an effect.
  const [supported, setSupported] = useState<boolean | null>(() => (isTauri() ? null : false))
  const [usage, setUsage] = useState<CodeServerDiskUsage | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  const refresh = useCallback(async () => {
    const next = await codeServerClient.diskUsage().catch(() => null)
    setUsage(next)
  }, [])

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void (async () => {
      const ok = await codeServerClient.supported().catch(() => false)
      if (cancelled) return
      setSupported(ok)
      if (ok) await refresh()
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // Live bar for the pre-fetch; the same event the editor pane listens to.
  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void onTauriEvent<CodeServerDownloadProgress>(CODESERVER_EVENTS.downloadProgress, (payload) => {
      if (cancelled) return
      setProgress(
        payload.stage === "downloading" && payload.bytesTotal > 0
          ? payload.bytesDone / payload.bytesTotal
          : null
      )
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [])

  const run = async (kind: NonNullable<Busy>, task: () => Promise<string>) => {
    setBusy(kind)
    try {
      toast.success(await task())
    } catch (cause) {
      toast.error(t("failed", { error: String(cause) }))
    } finally {
      setBusy(null)
      setProgress(null)
      await refresh()
    }
  }

  const download = () =>
    run("download", async () => {
      const info = await codeServerClient.download()
      return t("downloadDone", { version: info.version })
    })

  /**
   * `codeserver_uninstall` stops every running instance before it touches the
   * disk — in both modes, since deleting the tree under a live child leaves a
   * zombie. The native pane floats above the DOM and survives that on its own,
   * so tear it down here or the user is left with a dead VS Code page pinned
   * over the app.
   */
  const reclaim = async (everything: boolean) => {
    await destroyCodeServerPane()
    return codeServerClient.uninstall(everything)
  }

  const clean = () =>
    run("clean", async () => {
      const freed = await reclaim(false)
      return t("cleanDone", { size: formatBytes(freed) })
    })

  const uninstall = () => {
    setConfirmUninstall(false)
    return run("uninstall", async () => {
      const freed = await reclaim(true)
      return t("uninstallDone", { size: formatBytes(freed) })
    })
  }

  if (supported === false) {
    return (
      <Card data-testid="pro-ide-unsupported">
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("unsupported")}</CardDescription>
        </CardHeader>
      </Card>
    )
  }

  return (
    <Card data-testid="pro-ide-section">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2">
          <dt className="text-muted-foreground">{t("version")}</dt>
          <dd className="flex items-center gap-2">
            <span className="font-mono" data-testid="pro-ide-version">
              {usage?.version ?? "—"}
            </span>
            <Badge variant="secondary" data-testid="pro-ide-installed">
              {usage?.installed ? t("installed") : t("notInstalled")}
            </Badge>
          </dd>

          <dt className="text-muted-foreground">{t("diskUsage")}</dt>
          <dd className="font-mono tabular-nums" data-testid="pro-ide-total">
            {usage ? formatBytes(usage.totalBytes) : "—"}
          </dd>

          <dt className="text-muted-foreground">{t("reclaimable")}</dt>
          <dd className="font-mono tabular-nums" data-testid="pro-ide-reclaimable">
            {usage ? formatBytes(usage.reclaimableBytes) : "—"}
            {usage && usage.staleVersions.length > 0 ? (
              <span className="ml-2 font-sans text-xs text-muted-foreground">
                {t("staleVersions", { versions: usage.staleVersions.join(", ") })}
              </span>
            ) : null}
          </dd>

          <dt className="text-muted-foreground">{t("location")}</dt>
          <dd className="truncate font-mono text-xs" data-testid="pro-ide-root">
            {usage?.root ?? "—"}
          </dd>
        </dl>

        {busy === "download" && progress != null ? (
          <Progress value={Math.round(progress * 100)} data-testid="pro-ide-progress" />
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || usage?.installed === true}
            onClick={download}
            data-testid="pro-ide-download"
          >
            {busy === "download" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <DownloadIcon className="size-3.5" />
            )}
            {t("download")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || !usage || usage.reclaimableBytes === 0}
            onClick={clean}
            data-testid="pro-ide-clean"
          >
            <RotateCwIcon className="size-3.5" />
            {t("clean")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="text-destructive hover:text-destructive"
            disabled={busy !== null || !usage?.installed}
            onClick={() => setConfirmUninstall(true)}
            data-testid="pro-ide-uninstall"
          >
            <Trash2Icon className="size-3.5" />
            {t("uninstall")}
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <AlertDialogContent data-testid="pro-ide-uninstall-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("uninstallConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("uninstallConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="pro-ide-uninstall-confirm"
              onClick={uninstall}
            >
              {t("uninstall")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
