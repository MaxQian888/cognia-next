"use client"

// Settings surface for the Pro IDE (embedded code-server) *install*.
//
// Running instances are not managed here — every cognia-spawned child process
// lives in the performance panel's Managed Processes tab, code-server included
// (`src-tauri/src/process_registry`). This card owns what that tab cannot show:
// the pinned version, the on-disk footprint, pre-fetching the ~100-200MB
// tarball before the first switch, and reclaiming space afterwards.

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { DownloadIcon, Loader2Icon, RotateCwIcon, Trash2Icon, XIcon } from "lucide-react"
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
import { SurfaceUnavailableNotice } from "@/components/platform/surface-unavailable-notice"
import { ProIdeHostCard } from "./pro-ide-host-card"
import { useSurfaceReach } from "@/hooks/platform/use-surface-reach"
import {
  CODESERVER_EVENTS,
  type CodeServerDiskUsage,
  type CodeServerDownloadProgress,
  type CodeServerStatus,
  codeServerClient,
} from "@/lib/codeserver/client"
import { destroyCodeServerPane, getActiveProIdeRoot } from "@/lib/codeserver/pane-manager"
import { formatBytes } from "@/lib/perf/backend/format"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

type Busy = "download" | "clean" | "uninstall" | null

export function ProIdeSection() {
  const t = useTranslations("settings.proIde")
  /**
   * This card manages the LOCAL install: the pinned version, the on-disk
   * footprint, the pre-fetch, and reclaiming the space afterwards. All four of
   * its commands are `target: "client"` in `protocol/companion-commands.json`,
   * so they act on this machine and nowhere else. A paired companion has no
   * local code-server to manage, which is a different statement from "Pro IDE
   * is unavailable to you" and the reason this resolves a reach rather than
   * calling `isTauri()`.
   *
   * The settings-nav gate is deliberately looser than this one, so the section
   * stays reachable and can say the above instead of disappearing.
   */
  const reach = useSurfaceReach({ capability: "pro-ide", requirement: "desktop-shell" })
  // Outside the desktop shell there is nothing to probe — settle it up front
  // rather than round-tripping through an effect.
  const [supported, setSupported] = useState<boolean | null>(() => (isTauri() ? null : false))
  /**
   * The running instance, if any.
   *
   * `codeserver_status` had zero production callers, which is the one entry
   * from ADR-0088's own "zero callers" list that was never closed. The card
   * that owns the install is the right place to answer "is it running, and for
   * which workspace": the process registry shows a child process, but only the
   * bound root says which workspace the user is looking at.
   */
  const [running, setRunning] = useState<CodeServerStatus | null>(null)
  const [activeRoot, setActiveRoot] = useState<string | null>(null)
  const [usage, setUsage] = useState<CodeServerDiskUsage | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  /**
   * Set when the user backs out of a pre-fetch, so the rejection the backend
   * hands the in-flight `download()` is reported as "you cancelled" instead of
   * as a failure. A ref rather than state: it is read inside the `run` catch of
   * the very call that is unwinding, and a re-render in between would be a
   * cascading state write for no visual benefit.
   */
  const cancelledRef = useRef(false)

  const refresh = useCallback(async () => {
    const next = await codeServerClient.diskUsage().catch(() => null)
    setUsage(next)
    // `getActiveProIdeRoot()` survives a pane release on purpose, so this
    // answers for the workspace the user last opened even while the editor is
    // not on screen. A null root simply means nothing has been claimed yet.
    const root = getActiveProIdeRoot()
    const status = root ? await codeServerClient.status(root).catch(() => null) : null
    setActiveRoot(root)
    setRunning(status?.running ? status : null)
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
      // A cancelled pre-fetch rejects through this same path. Reporting it as a
      // failure would tell the user their own click went wrong.
      if (cancelledRef.current) toast.info(t("downloadCancelled"))
      else toast.error(t("failed", { error: String(cause) }))
    } finally {
      setBusy(null)
      setProgress(null)
      await refresh()
    }
  }

  const download = () => {
    cancelledRef.current = false
    return run("download", async () => {
      const info = await codeServerClient.download()
      return t("downloadDone", { version: info.version })
    })
  }

  /**
   * Back out of the ~100-200MB pre-fetch. Fire-and-forget by design: the backend
   * drops the streaming future and removes the partial archive, and the in-flight
   * `download()` above rejects on its own — so a cancel can never itself raise at
   * the user. Mirrors the editor pane's cancel affordance
   * (`components/editor/project/code-server-pane.tsx`); without it a mis-click on
   * "Download now" committed the user to the whole transfer.
   */
  const cancelDownload = () => {
    cancelledRef.current = true
    void codeServerClient.cancelDownload().catch(() => {})
  }

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

  if (!reach.available) {
    // Render, disable, explain. The old branch printed one sentence that said
    // "unsupported" whether the user was on Windows, on a phone, or in a
    // browser with nothing paired, which are three different situations with
    // three different next steps.
    //
    // The install card cannot help off the desktop shell, but the host's
    // workbench still can, so the companion card comes with it rather than
    // instead of it: "there is nothing to install here" and "there is nothing
    // you can do about Pro IDE" are not the same statement.
    return (
      <div className="flex flex-col gap-4">
        <Card data-testid="pro-ide-unsupported">
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
          </CardHeader>
          <CardContent>
            <SurfaceUnavailableNotice reach={reach} />
          </CardContent>
        </Card>
        <ProIdeHostCard />
      </div>
    )
  }

  if (supported === false) {
    // Reachable and still not possible: this IS the desktop, and there is no
    // prebuilt code-server for its platform or architecture.
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

          {/* The install answers "what is on disk". This answers "is any of it
              running, and for which workspace" — the question the managed-process
              tab cannot answer, because a child process does not carry a
              workspace root. */}
          <dt className="text-muted-foreground">{t("runningLabel")}</dt>
          <dd className="truncate text-xs" data-testid="pro-ide-running">
            {running ? (
              <span className="font-mono">{t("runningFor", { root: activeRoot ?? "" })}</span>
            ) : (
              t("runningNone")
            )}
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
          {busy === "download" ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={cancelDownload}
              data-testid="pro-ide-cancel-download"
            >
              <XIcon className="size-3.5" />
              {t("cancelDownload")}
            </Button>
          ) : null}
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
