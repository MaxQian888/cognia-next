"use client"

import RouteBody from "./route-body"

/**
 * `/servers/detail?id=…` — one deployment target.
 *
 * A static route reading the id from the query string rather than
 * `/servers/[id]`: the app is a Next.js static export, so a dynamic segment
 * would need every target id at build time, and target ids are created at
 * runtime by whoever registers them. Same shape as `/inbox/c`.
 */

import { Suspense, useEffect, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon } from "lucide-react"
import { toast } from "sonner"

import { OpsConnectPanel } from "@/components/servers/ops-connect-panel"
import { localizedOpsError, useServerOps } from "@/components/servers/ops-context"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { PageLoading } from "@/components/ui/loading-states"
import type {
  Operation,
  RecoveryPoint,
  ReleaseImages,
  ServerLogEntry,
} from "@/lib/server-ops/client"

/** Stable empty arrays so an unloaded target does not remount the tabs. */
const EMPTY_BACKUPS: readonly RecoveryPoint[] = []
const EMPTY_LOGS: readonly ServerLogEntry[] = []

function ServerDetailRoute() {
  const t = useTranslations("servers")
  const router = useRouter()
  const params = useSearchParams()
  const serverId = params.get("id") ?? ""
  const ops = useServerOps()
  /**
   * Keyed by the server it was loaded for, so a stale response for the previous
   * target is discarded during render rather than cleared by a second effect —
   * clearing it synchronously in an effect is what cascades renders.
   */
  const [detail, setDetail] = useState<{
    serverId: string
    backups: readonly RecoveryPoint[]
    logs: readonly ServerLogEntry[]
  } | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [inspected, setInspected] = useState<Operation | null>(null)

  const server = serverId ? ops.serverById(serverId) : null
  const { listBackups, listLogs, offline } = ops

  // The offline cache holds summaries only, so there is nothing truthful to
  // show here — better empty than a stale recovery point someone might restore
  // from.
  const fresh = detail?.serverId === serverId && !offline
  const backups = fresh ? detail.backups : EMPTY_BACKUPS
  const logs = fresh ? detail.logs : EMPTY_LOGS

  useEffect(() => {
    if (!serverId || !listBackups || !listLogs || offline) return
    let cancelled = false
    void (async () => {
      setLoadingDetail(true)
      try {
        const [nextBackups, nextLogs] = await Promise.all([
          listBackups(serverId),
          listLogs(serverId),
        ])
        if (!cancelled) setDetail({ serverId, backups: nextBackups, logs: nextLogs })
      } catch (error) {
        if (!cancelled) {
          toast.error(t("errors.detail"), { description: localizedOpsError(t, error) })
        }
      } finally {
        if (!cancelled) setLoadingDetail(false)
      }
    })()
    return () => {
      cancelled = true
    }
    // `ops.operations` is deliberately not a dependency: a finished operation
    // already triggers a fleet refresh, and re-fetching on every event would
    // hammer the controller while a deploy streams.
  }, [listBackups, listLogs, offline, serverId, t])

  if (!ops.localAccountId) {
    return (
      <div className="grid h-full w-full place-items-center p-6 text-sm text-muted-foreground">
        {t("connection.unlockAccount")}
      </div>
    )
  }

  if (!ops.connected || !ops.connection) return <OpsConnectPanel />

  const backToFleet = (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link href="/servers">
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        {t("actions.backToServers")}
      </Link>
    </Button>
  )

  if (!server) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b p-3">{backToFleet}</div>
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyTitle>{t("detail.missingTitle")}</EmptyTitle>
            <EmptyDescription>
              {ops.loading ? t("detail.loading") : t("detail.missingDescription")}
            </EmptyDescription>
          </EmptyHeader>
          <Button size="sm" variant="outline" onClick={() => router.push("/servers")}>
            {t("actions.backToServers")}
          </Button>
        </Empty>
      </div>
    )
  }

  const actions = {
    onBackup: () => void ops.backup(server.id),
    onPreflight: () => void ops.preflight(server.id),
    onCollectStatus: (includeRuntimeUsage: boolean) =>
      void ops.collectStatus(server.id, includeRuntimeUsage),
    onCollectLogs: () => void ops.collectLogs(server.id),
    onRestore: (recoveryPointId: string) => void ops.restore(server.id, recoveryPointId),
    onRollback: () => void ops.rollback(server.id),
    onRotateKey: (keyVersion: string) => void ops.rotateKey(server.id, keyVersion),
    onUpgrade: (release: ReleaseImages) => void ops.upgrade(server.id, release),
  }

  return (
    <RouteBody
      server={server}
      backups={backups}
      logs={logs}
      loadingDetail={loadingDetail}
      actions={actions}
      backToFleet={backToFleet}
      controllerUrl={ops.connection.controllerUrl}
      enrollOpen={enrollOpen}
      setEnrollOpen={setEnrollOpen}
      inspected={inspected}
      setInspected={setInspected}
    />
  )
}

export default function ServerDetailPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ServerDetailRoute />
    </Suspense>
  )
}
