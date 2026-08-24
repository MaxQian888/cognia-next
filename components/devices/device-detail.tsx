"use client"

/**
 * The detail pane: one device, five tabs.
 *
 * Two layout rules, both taken from `components/settings/mcp/mcp-panel.tsx`
 * where they were worked out: every tab body owns its own scroll container and
 * is `min-h-0 flex-1`, so switching tabs never resizes the pane and the header
 * never jumps. Deliberately no `AnimatePresence` here — a crossfade between
 * tabs of very different heights is exactly what causes the jump those rules
 * exist to prevent, and motion that strands an element at opacity 0 is
 * invisible to jsdom, so the failure would only ever be seen by a user.
 */

import { useTranslations } from "next-intl"

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import type { DeviceRow } from "@/lib/devices/types"
import type { DeviceGrantActions } from "@/hooks/devices/use-device-grant-actions"
import { DEVICE_DETAIL_TABS, type DeviceDetailTab } from "@/stores/devices/device-console-store"

import {
  AdminStateBadge,
  DeviceKindIcon,
  DeviceKindLabel,
  ReachabilityLabel,
} from "./device-visuals"
import { AccessTab } from "./tabs/access-tab"
import { ActivityTab } from "./tabs/activity-tab"
import { CapabilitiesTab } from "./tabs/capabilities-tab"
import { OverviewTab } from "./tabs/overview-tab"
import { RuntimeTab } from "./tabs/runtime-tab"

export interface DeviceDetailProps {
  row: DeviceRow | null
  activeTab: DeviceDetailTab
  onTabChange: (tab: DeviceDetailTab) => void
  actions: DeviceGrantActions
}

export function DeviceDetail({ row, activeTab, onTabChange, actions }: DeviceDetailProps) {
  const t = useTranslations("devices")

  if (!row) {
    return (
      <Empty className="h-full border-none" data-testid="device-detail-empty">
        <EmptyHeader>
          <EmptyTitle>{t("detail.noSelectionTitle")}</EmptyTitle>
          <EmptyDescription>{t("detail.noSelectionBody")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="device-detail">
      <header className="shrink-0 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <DeviceKindIcon kind={row.kind} className="size-5" />
          <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{row.label}</h2>
          <AdminStateBadge state={row.adminState} />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-xs text-muted-foreground">
            <DeviceKindLabel kind={row.kind} />
          </span>
          <ReachabilityLabel reachability={row.reachability} />
        </div>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as DeviceDetailTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="mx-4 mt-3 shrink-0 self-start">
          {DEVICE_DETAIL_TABS.map((tab) => (
            <TabsTrigger key={tab} value={tab} data-testid={`device-tab-${tab}`}>
              {t(`detail.tab.${tab}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* Each body owns its own scroll container so switching tabs cannot
            resize the pane — the rule `mcp-panel.tsx` documents. */}
        <TabsContent value="overview" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <OverviewTab row={row} />
        </TabsContent>
        <TabsContent value="capabilities" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <CapabilitiesTab row={row} />
        </TabsContent>
        <TabsContent value="access" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <AccessTab row={row} actions={actions} />
        </TabsContent>
        <TabsContent value="runtime" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <RuntimeTab row={row} />
        </TabsContent>
        <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <ActivityTab row={row} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
