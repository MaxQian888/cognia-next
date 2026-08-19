"use client"

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
import { ArrowLeftIcon, LogOutIcon, PlugZapIcon, RefreshCwIcon } from "lucide-react"
import { toast } from "sonner"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { ConnectAgentDialog } from "@/components/servers/connect-agent-dialog"
import { OperationInspector } from "@/components/servers/operation-inspector"
import { OperationsRail } from "@/components/servers/operations-rail"
import { OpsConnectPanel } from "@/components/servers/ops-connect-panel"
import { localizedOpsError, useServerOps } from "@/components/servers/ops-context"
import { ServerDetailView } from "@/components/servers/server-detail"
import { HealthLabel } from "@/components/servers/server-visuals"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { PageLoading } from "@/components/ui/loading-states"
import type { Operation, RecoveryPoint, ServerLogEntry } from "@/lib/server-ops/client"

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

  if (!ops.accountId) {
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

  return (
    <>
      <FeaturePageShell
        storageId="server-detail"
        header={
          <FeaturePageHeader
            variant="management"
            breadcrumb={backToFleet}
            title={server.label || server.id}
            context={
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <HealthLabel health={server.health} />
                <span aria-hidden="true">·</span>
                <span className="truncate font-mono">{server.id}</span>
                {server.publicUrl && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="truncate">{server.publicUrl}</span>
                  </>
                )}
              </span>
            }
            secondaryActions={[
              {
                id: "enroll",
                label: t("enroll.action"),
                icon: PlugZapIcon,
                onSelect: () => setEnrollOpen(true),
              },
              {
                id: "refresh",
                label: t("actions.refresh"),
                icon: RefreshCwIcon,
                onSelect: () => void ops.refresh(),
                disabled: ops.loading,
              },
            ]}
            overflowActions={[
              {
                id: "disconnect",
                label: t("connection.disconnect"),
                icon: LogOutIcon,
                onSelect: () => void ops.disconnect(),
                destructive: true,
              },
            ]}
            overflowLabel={t("actions.more")}
          />
        }
        rightPane={{
          label: t("operations.ariaLabel"),
          content: (
            <OperationsRail
              operations={ops.operations}
              liveEvents={ops.liveEvents}
              eventStreamConnected={ops.eventStreamConnected}
              selectedId={inspected?.id ?? null}
              onSelect={setInspected}
              targetId={server.id}
            />
          ),
        }}
      >
        <ServerDetailView
          server={server}
          backups={backups}
          logs={logs}
          loadingDetail={loadingDetail}
          actions={{
            onBackup: () => void ops.backup(server.id),
            onPreflight: () => void ops.preflight(server.id),
            onCollectStatus: (includeRuntimeUsage) =>
              void ops.collectStatus(server.id, includeRuntimeUsage),
            onCollectLogs: () => void ops.collectLogs(server.id),
            onRestore: (recoveryPointId) => void ops.restore(server.id, recoveryPointId),
            onRollback: () => void ops.rollback(server.id),
            onRotateKey: (keyVersion) => void ops.rotateKey(server.id, keyVersion),
            onUpgrade: (release) => void ops.upgrade(server.id, release),
            onConnectAgent: () => setEnrollOpen(true),
          }}
        />
      </FeaturePageShell>

      <ConnectAgentDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        servers={ops.servers}
        controllerUrl={ops.connection.controllerUrl}
        initialTargetId={server.id}
        onIssueToken={ops.createEnrollmentToken}
        onRefresh={ops.refresh}
      />
      <OperationInspector
        operation={inspected}
        onOpenChange={(open) => !open && setInspected(null)}
        onCancel={(id) => {
          void ops.cancelOperation(id)
          setInspected(null)
        }}
      />
    </>
  )
}

export default function ServerDetailPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ServerDetailRoute />
    </Suspense>
  )
}
