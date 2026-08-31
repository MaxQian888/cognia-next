"use client"

/**
 * `/servers/detail?id=…` on a phone.
 *
 * The desktop route is a three-pane shell whose right pane is the operations
 * rail. Below `md` that pane collapses into a panel icon, which is the wrong
 * container for the surface a running deploy reports itself on, so the rail
 * moves behind a labelled trigger that carries the in-flight count.
 *
 * Everything else is the desktop's own component. `ServerDetailView` holds all
 * five tabs and every action, and it is rendered here verbatim rather than
 * reduced: a phone that could look at a target but not roll it back would be
 * the surface saying "you have to go and find a laptop", which is exactly what
 * this route exists to avoid.
 *
 * Data loading stays on the route. This is the body it hands its results to,
 * the same split `devices-mobile-body` uses, so the two shells cannot drift on
 * what "loading" or "offline" mean.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { ArrowLeftIcon, PlugZapIcon, RefreshCwIcon } from "lucide-react"

import { ConnectAgentDialog } from "@/components/servers/connect-agent-dialog"
import { OperationInspector } from "@/components/servers/operation-inspector"
import { useServerOps } from "@/components/servers/ops-context"
import { ServerDetailView, type ServerDetailActions } from "@/components/servers/server-detail"
import { HealthLabel } from "@/components/servers/server-visuals"
import { Button } from "@/components/ui/button"
import type { Operation, RecoveryPoint, ServerDetail, ServerLogEntry } from "@/lib/server-ops/client"

import { MobileOperationsSheet } from "./operations-sheet"

export interface ServerDetailMobileBodyProps {
  server: ServerDetail
  backups: readonly RecoveryPoint[]
  logs: readonly ServerLogEntry[]
  loadingDetail: boolean
  actions: Omit<ServerDetailActions, "onConnectAgent">
}

export function ServerDetailMobileBody({
  server,
  backups,
  logs,
  loadingDetail,
  actions,
}: ServerDetailMobileBodyProps) {
  const t = useTranslations("servers")
  const ops = useServerOps()
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [inspected, setInspected] = useState<Operation | null>(null)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="server-detail-mobile-body">
      <header className="safe-area-pt shrink-0 border-b px-3 py-2">
        <Button asChild variant="ghost" size="sm" className="-ml-2 h-8">
          <Link href="/servers" data-testid="mobile-server-detail-back">
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {t("actions.backToServers")}
          </Link>
        </Button>

        <div className="mt-1 min-w-0">
          <h1 className="truncate text-base font-semibold">{server.label || server.id}</h1>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            <HealthLabel health={server.health} />
            <span aria-hidden="true">·</span>
            <span className="truncate font-mono">{server.id}</span>
          </div>
          {/*
            Its own line rather than a third item in that row: a public URL is
            the longest string on this screen and wrapping it into the health
            row pushes the health label off the top of the fold.
          */}
          {server.publicUrl ? (
            <p className="truncate text-[11px] text-muted-foreground">{server.publicUrl}</p>
          ) : null}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => setEnrollOpen(true)}
            data-testid="mobile-server-detail-enroll"
          >
            <PlugZapIcon className="size-3.5" />
            {t("enroll.action")}
          </Button>
          <MobileOperationsSheet
            operations={ops.operations}
            liveEvents={ops.liveEvents}
            eventStreamConnected={ops.eventStreamConnected}
            onSelect={setInspected}
            targetId={server.id}
          />
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto size-8"
            aria-label={t("actions.refresh")}
            disabled={ops.loading}
            onClick={() => void ops.refresh()}
            data-testid="mobile-server-detail-refresh"
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <ServerDetailView
          server={server}
          backups={backups}
          logs={logs}
          loadingDetail={loadingDetail}
          actions={{ ...actions, onConnectAgent: () => setEnrollOpen(true) }}
        />
      </div>

      {ops.connection ? (
        <ConnectAgentDialog
          open={enrollOpen}
          onOpenChange={setEnrollOpen}
          servers={ops.servers}
          controllerUrl={ops.connection.controllerUrl}
          initialTargetId={server.id}
          onIssueToken={ops.createEnrollmentToken}
          onRefresh={ops.refresh}
        />
      ) : null}
      <OperationInspector
        operation={inspected}
        loadEvents={ops.listOperationEvents}
        onOpenChange={(open) => !open && setInspected(null)}
        onCancel={(id) => {
          void ops.cancelOperation(id)
          setInspected(null)
        }}
      />
    </div>
  )
}
