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
import { cn } from "@/lib/utils"
import { useAdapterHealth } from "@/hooks/connectors/use-adapter-health"
import { getAdapterTransportLabelKey, getPlatformMeta } from "./platform-meta"
import { deriveAdapterStatus } from "./adapter-status"
import { healthReasonLabel } from "./tabs/health-reason-label"
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
  const tHealth = useTranslations("settings.connections.adapters.health")
  const { activeTab, setActiveTab } = useSelectedAdapter()
  const health = useAdapterHealth(adapterId)
  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  if (!row) {
    return (
      <div className="px-4 py-6 text-center text-xs text-muted-foreground">
        {t("detail.adapterMissing")}
      </div>
    )
  }

  const { labelKey, Icon } = getPlatformMeta(row.type)
  const platformLabel = t(`platforms.${labelKey}`)
  const transportLabelKey = getAdapterTransportLabelKey(row.type, row.transportMode)
  const transportLabel = transportLabelKey ? t(transportLabelKey) : row.transportMode
  const status = deriveAdapterStatus(row.enabled, health)
  const StatusIcon = status.Icon
  const statusReason = healthReasonLabel(tHealth, status.reason)

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="adapter-detail-panel">
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold">{row.displayName}</h3>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {row.type}
            </Badge>
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {platformLabel} · {transportLabel}
          </p>
        </div>
        <div className="flex flex-wrap shrink-0 items-center justify-end gap-2">
          <span
            data-testid="adapter-detail-status"
            data-status={status.status}
            title={statusReason}
            className={cn(
              "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
              status.tint
            )}
          >
            <StatusIcon className="size-3" aria-hidden />
            {t(status.labelKey)}
          </span>
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
            className="cursor-pointer text-xs text-muted-foreground"
          >
            {row.enabled ? t("enabled") : t("disabled")}
          </label>
        </div>
      </div>

      {/* Inner tabs — body scrolls inside the pane, header stays pinned */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as AdapterDetailTab)}>
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="config" className="shrink-0">
              {t("detailTabs.config")}
            </TabsTrigger>
            <TabsTrigger value="health" className="shrink-0">
              {t("detailTabs.health")}
            </TabsTrigger>
            <TabsTrigger value="conversations" className="shrink-0">
              {t("detailTabs.conversations")}
            </TabsTrigger>
            <TabsTrigger value="audit" className="shrink-0">
              {t("detailTabs.audit")}
            </TabsTrigger>
            <TabsTrigger value="outbound" className="shrink-0">
              {t("detailTabs.outbound")}
            </TabsTrigger>
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
    </div>
  )
}
