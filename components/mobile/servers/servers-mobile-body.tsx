"use client"

/**
 * `/servers` on a phone.
 *
 * `components/servers/**` had no responsive branch at all, so the deployment
 * fleet arrived as a desktop three-pane squeezed into `FeaturePageShell`'s
 * generic fallback: the centre column, plus two 16px panel icons for the panes
 * that carry the operations rail.
 *
 * This inverts it the same way `devices-mobile-body` does, and for the same
 * reason: the fleet is not a sidebar here, it is the page, and the running work
 * is what should arrive on demand. `ServerFleet` is the component the desktop
 * renders, unchanged, so a target can never read one way here and another
 * there.
 *
 * A row still navigates to `/servers/detail?id=…` rather than opening a
 * drawer. The list and the detail are separate navigation stacks on a phone,
 * which is what makes the back gesture return to the fleet with its filter and
 * scroll position intact.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { LogOutIcon, PlugZapIcon, RefreshCwIcon, RocketIcon } from "lucide-react"

import { ConnectAgentDialog } from "@/components/servers/connect-agent-dialog"
import { DeploymentWizard } from "@/components/servers/deployment-wizard"
import { OperationInspector } from "@/components/servers/operation-inspector"
import { OpsConnectPanel } from "@/components/servers/ops-connect-panel"
import { useServerOps } from "@/components/servers/ops-context"
import { ServerFleet, type FleetFilter } from "@/components/servers/server-fleet"
import { PullToRefresh } from "@/components/interactions/pull-to-refresh"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { Operation } from "@/lib/server-ops/client"

import { MobileOperationsSheet } from "./operations-sheet"

export function ServersMobileBody() {
  const t = useTranslations("servers")
  const ops = useServerOps()
  const [filter, setFilter] = useState<FleetFilter>("all")
  const [wizardOpen, setWizardOpen] = useState(false)
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [inspected, setInspected] = useState<Operation | null>(null)

  /**
   * Both gates are the desktop route's, kept identical rather than softened
   * for a small screen. A locked account and an unconnected controller are the
   * same two facts here, and a phone that showed an empty fleet instead would
   * be inventing a third.
   */
  if (!ops.accountId) {
    return (
      <div className="grid h-full w-full place-items-center p-6 text-center text-sm text-muted-foreground">
        {t("connection.unlockAccount")}
      </div>
    )
  }
  if (!ops.connected || !ops.connection) return <OpsConnectPanel />

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="servers-mobile-body">
      <header className="safe-area-pt shrink-0 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold">{t("title")}</h1>
            {/*
              Which controller this is, the first thing to check when a fleet
              looks wrong. The desktop puts it in the header's context slot.
              There is no such slot here, so it goes under the title.
            */}
            <p className="truncate font-mono text-[11px] text-muted-foreground">
              {ops.connection.controllerUrl}
            </p>
          </div>
          {ops.offline ? <Badge variant="outline">{t("offline")}</Badge> : null}
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={t("actions.refresh")}
            disabled={ops.loading}
            onClick={() => void ops.refresh()}
            data-testid="mobile-servers-refresh"
          >
            <RefreshCwIcon className="size-4" />
          </Button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-8"
            onClick={() => setWizardOpen(true)}
            data-testid="mobile-servers-deploy"
          >
            <RocketIcon className="size-3.5" />
            {t("actions.deploy")}
          </Button>
          {/*
            Not disabled on an empty fleet, matching the desktop: the dialog's
            own "No targets yet" state explains that a token binds to a target,
            which a dead button does not.
          */}
          <Button
            size="sm"
            variant="outline"
            className="h-8"
            onClick={() => setEnrollOpen(true)}
            data-testid="mobile-servers-enroll"
          >
            <PlugZapIcon className="size-3.5" />
            {t("enroll.action")}
          </Button>
          <MobileOperationsSheet
            operations={ops.operations}
            liveEvents={ops.liveEvents}
            eventStreamConnected={ops.eventStreamConnected}
            onSelect={setInspected}
          />
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-8 text-muted-foreground"
            onClick={() => void ops.disconnect()}
            data-testid="mobile-servers-disconnect"
          >
            <LogOutIcon className="size-3.5" />
            {t("connection.disconnect")}
          </Button>
        </div>
      </header>

      <PullToRefresh onRefresh={ops.refresh} className="min-h-0 flex-1">
        <ServerFleet
          servers={ops.servers}
          operations={ops.operations}
          loading={ops.loading}
          filter={filter}
          onFilterChange={setFilter}
          onConnectAgent={() => setEnrollOpen(true)}
          onDeploy={() => setWizardOpen(true)}
        />
      </PullToRefresh>

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
    </div>
  )
}
