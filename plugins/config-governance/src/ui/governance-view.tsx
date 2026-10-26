"use client"

import { useState } from "react"
import type { PluginViewProps } from "@cognia/plugin-sdk"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import {
  Button,
  Progress,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@cognia/plugin-ui"

import { PLUGIN_ID } from "../model"
import { errorMessage } from "./act"
import { AdherenceTab } from "./adherence-tab"
import { EnforcementTab } from "./enforcement-tab"
import { FindingsTab } from "./findings-tab"
import { InventoryTab } from "./inventory-tab"
import { OverviewTab } from "./overview-tab"
import {
  useActiveRuntime,
  useGovernanceData,
  useRuntimeStatus,
  useWorkspaces,
} from "./use-governance"
import { VerifyTab } from "./verify-tab"

/** The account-only choice in the workspace picker. */
export const ACCOUNT_CHOICE = "__account__"

export const TABS = [
  "overview",
  "findings",
  "adherence",
  "enforcement",
  "verify",
  "inventory",
] as const

export function GovernanceView(_props: PluginViewProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const runtime = useActiveRuntime()
  const status = useRuntimeStatus(runtime)
  const { workspaces, initial } = useWorkspaces(runtime)
  const [choice, setChoice] = useState<string | null | undefined>(undefined)
  const workspaceId = choice !== undefined ? choice : initial
  const state = useGovernanceData(runtime, workspaceId, status.revision)
  const busy = status.busy !== undefined

  if (!runtime) {
    return <p className="p-3 text-xs text-muted-foreground">{t("view.inactive")}</p>
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="governance-view">
      <div className="flex flex-wrap items-center gap-2 border-b p-2">
        <Select
          value={workspaceId === null ? ACCOUNT_CHOICE : (workspaceId ?? ACCOUNT_CHOICE)}
          onValueChange={(value) => setChoice(value === ACCOUNT_CHOICE ? null : value)}
        >
          <SelectTrigger className="h-7 w-56 text-xs" aria-label={t("view.workspace")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ACCOUNT_CHOICE}>{t("view.accountOnly")}</SelectItem>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {status.busy && (
          <div className="flex min-w-0 flex-1 items-center gap-2" data-testid="governance-busy">
            <span className="truncate text-[11px] text-muted-foreground">
              {t(`busy.${status.busy.kind}`, { label: status.busy.label })}
            </span>
            {status.busy.total > 0 && (
              <Progress
                className="h-1.5 w-24"
                value={(status.busy.done / status.busy.total) * 100}
              />
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              onClick={() => runtime.cancel()}
            >
              {t("common.cancel")}
            </Button>
          </div>
        )}
        {!status.busy && status.error && (
          <span className="truncate text-[11px] text-destructive" data-testid="governance-error">
            {t(`failed.${status.error.kind}`, { error: errorMessage(status.error, t) })}
          </span>
        )}
      </div>
      {state.status === "loading" && (
        <p className="p-3 text-xs text-muted-foreground">{t("common.loading")}</p>
      )}
      {state.status === "error" && <p className="p-3 text-xs text-destructive">{state.message}</p>}
      {state.status === "ready" && (
        <Tabs defaultValue="overview" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-2 mt-2 flex-wrap">
            {TABS.map((tab) => (
              <TabsTrigger key={tab} value={tab} className="text-xs">
                {t(`tabs.${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <ScrollArea className="min-h-0 flex-1">
            <TabsContent value="overview">
              <OverviewTab
                runtime={runtime}
                workspaceId={state.workspaceId}
                data={state.data}
                busy={busy}
              />
            </TabsContent>
            <TabsContent value="findings">
              <FindingsTab
                runtime={runtime}
                workspaceId={state.workspaceId}
                data={state.data}
                busy={busy}
              />
            </TabsContent>
            <TabsContent value="adherence">
              <AdherenceTab
                runtime={runtime}
                workspaceId={state.workspaceId}
                data={state.data}
                busy={busy}
              />
            </TabsContent>
            <TabsContent value="enforcement">
              <EnforcementTab
                runtime={runtime}
                data={state.data}
                workspaces={workspaces}
                enforcementEnabled={runtime.enforcementEnabled()}
              />
            </TabsContent>
            <TabsContent value="verify">
              <VerifyTab
                runtime={runtime}
                workspaceId={state.workspaceId}
                data={state.data}
                busy={busy}
              />
            </TabsContent>
            <TabsContent value="inventory">
              <InventoryTab
                key={`${state.workspaceId ?? ACCOUNT_CHOICE}:${status.revision}`}
                runtime={runtime}
                workspaceId={state.workspaceId}
                data={state.data}
                busy={busy}
              />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      )}
    </div>
  )
}
