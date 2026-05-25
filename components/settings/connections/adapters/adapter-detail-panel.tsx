"use client"

/**
 * Sidebar + detail panel container for Settings → Connections → Adapters
 * (im-refactored-crayon).
 *
 * Mounted by `AdaptersTab` when an adapter is selected. Top section is a
 * lightweight header (display name + type + master enable Switch). The
 * body is an inner Tabs shell with Config / Health / Conversations /
 * Audit and (for Lark adapters) a Debug pill — for now the Debug pill
 * is hidden because debug-send + event-stream sub-cards are tracked as
 * follow-up work in the plan.
 *
 * The inner-tab selection is URL-state-backed via `useSelectedAdapter`.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { SettingsCard } from "@/components/settings/common/settings-section"
import { getPlatformMeta } from "./platform-meta"
import { ConfigDetail } from "./tabs/config-detail"
import { HealthDetail } from "./tabs/health-detail"
import { ConversationsDetail } from "./tabs/conversations-detail"
import { AuditTab } from "../tabs/audit-tab"
import { OutboundTab } from "../tabs/outbound-tab"
import { useSelectedAdapter, type AdapterDetailTab } from "./use-selected-adapter"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface AdapterDetailPanelProps {
  adapterId: string
}

export function AdapterDetailPanel({ adapterId }: AdapterDetailPanelProps) {
  const t = useTranslations("settings.connections.adapters")
  const { activeTab, setActiveTab } = useSelectedAdapter()
  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  if (!row) {
    return (
      <Card>
        <CardContent className="py-6 text-center text-xs text-muted-foreground">
          {t("detail.adapterMissing")}
        </CardContent>
      </Card>
    )
  }

  const { Icon } = getPlatformMeta(row.type)

  return (
    <div className="space-y-4" data-testid="adapter-detail-panel">
      <SettingsCard
        icon={<Icon className="size-4" />}
        title={row.displayName}
        badge={row.type}
        badgeVariant="outline"
        headerAction={
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="shrink-0 text-xs">
              {row.defaultMode}
            </Badge>
            <Switch
              id={`detail-enabled-${row.id}`}
              checked={row.enabled}
              onCheckedChange={() => void updateAdapterInstance(row.id, { enabled: !row.enabled })}
              aria-label={
                row.enabled
                  ? t("disableAria", { name: row.displayName })
                  : t("enableAria", { name: row.displayName })
              }
              data-testid="adapter-detail-toggle"
            />
            <label
              htmlFor={`detail-enabled-${row.id}`}
              className="text-xs text-muted-foreground cursor-pointer"
            >
              {row.enabled ? t("enabled") : t("disabled")}
            </label>
          </div>
        }
      >
        <></>
      </SettingsCard>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as AdapterDetailTab)}>
        <TabsList>
          <TabsTrigger value="config">{t("detailTabs.config")}</TabsTrigger>
          <TabsTrigger value="health">{t("detailTabs.health")}</TabsTrigger>
          <TabsTrigger value="conversations">{t("detailTabs.conversations")}</TabsTrigger>
          <TabsTrigger value="audit">{t("detailTabs.audit")}</TabsTrigger>
          <TabsTrigger value="outbound">{t("detailTabs.outbound")}</TabsTrigger>
        </TabsList>
        <TabsContent value="config" className="mt-4">
          <ConfigDetail row={row} />
        </TabsContent>
        <TabsContent value="health" className="mt-4">
          <HealthDetail adapterId={adapterId} />
        </TabsContent>
        <TabsContent value="conversations" className="mt-4">
          <ConversationsDetail adapterId={adapterId} />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab adapterId={adapterId} />
        </TabsContent>
        <TabsContent value="outbound" className="mt-4">
          <OutboundTab adapterId={adapterId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
