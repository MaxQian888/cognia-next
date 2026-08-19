"use client"

/**
 * `/servers` — the deployment-target fleet.
 *
 * Thin by design: the controller session lives in the route layout, so this
 * page only owns which dialog is open and which health filter is applied.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LogOutIcon, PlugZapIcon, RefreshCwIcon, RocketIcon, ServerCogIcon } from "lucide-react"

import { FeaturePageHeader } from "@/components/feature-shell/feature-page-header"
import { FeaturePageShell } from "@/components/feature-shell/feature-page-shell"
import { ConnectAgentDialog } from "@/components/servers/connect-agent-dialog"
import { DeploymentWizard } from "@/components/servers/deployment-wizard"
import { OperationInspector } from "@/components/servers/operation-inspector"
import { OperationsRail } from "@/components/servers/operations-rail"
import { OpsConnectPanel } from "@/components/servers/ops-connect-panel"
import { useServerOps } from "@/components/servers/ops-context"
import { ServerFleet, type FleetFilter } from "@/components/servers/server-fleet"
import { Badge } from "@/components/ui/badge"
import type { Operation } from "@/lib/server-ops/client"

export default function ServersPage() {
  const t = useTranslations("servers")
  const ops = useServerOps()
  const [filter, setFilter] = useState<FleetFilter>("all")
  const [wizardOpen, setWizardOpen] = useState(false)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [inspected, setInspected] = useState<Operation | null>(null)

  if (!ops.accountId) {
    return (
      <div className="grid h-full w-full place-items-center p-6 text-sm text-muted-foreground">
        {t("connection.unlockAccount")}
      </div>
    )
  }

  if (!ops.connected || !ops.connection) return <OpsConnectPanel />

  return (
    <>
      <FeaturePageShell
        storageId="servers"
        header={
          <FeaturePageHeader
            variant="management"
            icon={<ServerCogIcon className="size-4" aria-hidden="true" />}
            title={t("title")}
            description={t("description")}
            context={
              <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate font-mono">{ops.connection.controllerUrl}</span>
                <span aria-hidden="true">·</span>
                <span className="truncate">{ops.connection.profileId}</span>
                {ops.offline && <Badge variant="outline">{t("offline")}</Badge>}
              </span>
            }
            summary={t("fleet.summary", { count: ops.servers.length })}
            primaryAction={{
              id: "deploy",
              label: t("actions.deploy"),
              icon: RocketIcon,
              onSelect: () => setWizardOpen(true),
            }}
            secondaryActions={[
              {
                // Deliberately not disabled on an empty fleet: the dialog's own
                // "No targets yet" state explains that a token binds to a
                // target, which a dead button does not.
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
            />
          ),
        }}
      >
        <ServerFleet
          servers={ops.servers}
          operations={ops.operations}
          loading={ops.loading}
          filter={filter}
          onFilterChange={setFilter}
          onConnectAgent={() => setEnrollOpen(true)}
          onDeploy={() => setWizardOpen(true)}
        />
      </FeaturePageShell>

      <DeploymentWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        capabilities={ops.capabilities}
        onSubmit={ops.registerAndDeploy}
      />
      <ConnectAgentDialog
        open={enrollOpen}
        onOpenChange={setEnrollOpen}
        servers={ops.servers}
        controllerUrl={ops.connection.controllerUrl}
        onIssueToken={ops.createEnrollmentToken}
        onRefresh={ops.refresh}
      />
      <OperationInspector
        operation={inspected}
        loadEvents={ops.listOperationEvents}
        onOpenChange={(open) => !open && setInspected(null)}
        onCancel={(id) => {
          void ops.cancelOperation(id)
          setInspected(null)
        }}
      />
    </>
  )
}
