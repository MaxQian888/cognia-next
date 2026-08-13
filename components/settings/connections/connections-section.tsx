"use client"

// Tabbed shell for the Connections (Platform Connectors) settings section.
// The `?connectionsTab=` parameter is the stable deep-link contract shared by
// connector forms and paired clients; each tab implementation lives in `./tabs/`.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { LinkIcon, MonitorIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { usePlatform } from "@/hooks/use-platform"
import { OverviewTab } from "./tabs/overview-tab"
import { AdaptersTab } from "./tabs/adapters-tab"
import { OutboundTab } from "./tabs/outbound-tab"
import { AuditTab } from "./tabs/audit-tab"
import { ConversationsTab } from "./tabs/conversations-tab"
import { CapabilityMatrixTab } from "./tabs/capability-matrix-tab"
import { InboxAssetsTab } from "./tabs/inbox-assets-tab"

const CONNECTIONS_TAB_PARAM = "connectionsTab"

export type ConnectionsTabId =
  "overview" | "adapters" | "overrides" | "outbound" | "audit" | "capability" | "assets"

const TAB_IDS: ConnectionsTabId[] = [
  "overview",
  "adapters",
  "overrides",
  "outbound",
  "audit",
  "capability",
  "assets",
]

function isConnectionsTab(value: string | null): value is ConnectionsTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function ConnectionsSection() {
  const t = useTranslations("settings.connections")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(CONNECTIONS_TAB_PARAM)
  // Preserve old Tunnel deep links after moving tunnel controls into Overview.
  const activeTab: ConnectionsTabId = isConnectionsTab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isConnectionsTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(CONNECTIONS_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  const desktop = usePlatform() === "tauri"

  // Tab bodies that are plain content scroll as a single block inside the fixed
  // frame. The Adapters tab owns a master-detail layout that manages its own
  // internal scroll (mirroring the AI Provider page), so it fills the frame
  // without an outer scroll region.
  const scrollBlock = "mt-4 min-h-0 flex-1 overflow-y-auto pr-1"
  const fillBlock = "mt-4 min-h-0 flex-1 overflow-hidden"

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="shrink-0 space-y-1">
        <Label className="flex items-center gap-2">
          <LinkIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {!desktop && (
        <Alert role="status" aria-label={t("webModeBanner.ariaLabel")} className="shrink-0">
          <MonitorIcon className="size-4" />
          <AlertDescription>{t("webModeBanner.body")}</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange} className="min-h-0 flex-1">
        <TabsList className="w-full shrink-0 justify-start overflow-x-auto">
          <TabsTrigger value="overview" className="shrink-0">
            {t("tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="adapters" className="shrink-0">
            {t("tabs.adapters")}
          </TabsTrigger>
          <TabsTrigger value="overrides" className="shrink-0">
            {t("tabs.overrides")}
          </TabsTrigger>
          <TabsTrigger value="outbound" className="shrink-0">
            {t("tabs.outbound")}
          </TabsTrigger>
          <TabsTrigger value="audit" className="shrink-0">
            {t("tabs.audit")}
          </TabsTrigger>
          <TabsTrigger value="capability" className="shrink-0">
            {t("tabs.capability")}
          </TabsTrigger>
          <TabsTrigger value="assets" className="shrink-0">
            {t("tabs.assets")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className={scrollBlock}>
          <OverviewTab />
        </TabsContent>
        <TabsContent value="adapters" className={fillBlock}>
          <AdaptersTab />
        </TabsContent>
        <TabsContent value="overrides" className={scrollBlock}>
          <ConversationsTab />
        </TabsContent>
        <TabsContent value="outbound" className={scrollBlock}>
          <OutboundTab />
        </TabsContent>
        <TabsContent value="audit" className={scrollBlock}>
          <AuditTab />
        </TabsContent>
        <TabsContent value="capability" className={scrollBlock}>
          <CapabilityMatrixTab />
        </TabsContent>
        <TabsContent value="assets" className={scrollBlock}>
          <InboxAssetsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
