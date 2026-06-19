"use client"

// Tabbed shell for the Connections (Platform Connectors) settings section.
// Mirrors `remote-control/remote-control-section.tsx` 1:1 — only the param
// name (`?connectionsTab=`) and tab ids differ. The four tab implementations
// live in `./tabs/`.
//
// SCOPE NOTE (CP-Phase-1):
// The original plan listed 6 tabs (Overview / Adapters / Conversations / Inbox
// / Outbound / Audit). Conversations + Inbox tabs have been dropped for Phase 1
// because the Inbox UI already lives at `/inbox/*` routes and per-conversation
// override UI is CP-C scope. Phase 1 ships 4 tabs: Overview / Adapters /
// Outbound / Audit.

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
import { InboxTab } from "./tabs/inbox-tab"
import { CapabilityMatrixTab } from "./tabs/capability-matrix-tab"
import { LabelsTab } from "./tabs/labels-tab"
import { CannedResponsesTab } from "./tabs/canned-responses-tab"

const CONNECTIONS_TAB_PARAM = "connectionsTab"

export type ConnectionsTabId =
  | "overview"
  | "adapters"
  | "conversations"
  | "inbox"
  | "outbound"
  | "audit"
  | "capability"
  | "labels"
  | "canned"

const TAB_IDS: ConnectionsTabId[] = [
  "overview",
  "adapters",
  "conversations",
  "inbox",
  "outbound",
  "audit",
  "capability",
  "labels",
  "canned",
]

function isConnectionsTab(value: string | null): value is ConnectionsTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function ConnectionsSection() {
  const t = useTranslations("settings.connections")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(CONNECTIONS_TAB_PARAM)
  const activeTab: ConnectionsTabId = isConnectionsTab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isConnectionsTab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(CONNECTIONS_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  const desktop = usePlatform() === "tauri"

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <LinkIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {!desktop && (
        <Alert role="status" aria-label={t("webModeBanner.ariaLabel")}>
          <MonitorIcon className="size-4" />
          <AlertDescription>{t("webModeBanner.body")}</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview" className="shrink-0">
            {t("tabs.overview")}
          </TabsTrigger>
          <TabsTrigger value="adapters" className="shrink-0">
            {t("tabs.adapters")}
          </TabsTrigger>
          <TabsTrigger value="conversations" className="shrink-0">
            {t("tabs.conversations")}
          </TabsTrigger>
          <TabsTrigger value="inbox" className="shrink-0">
            {t("tabs.inbox")}
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
          <TabsTrigger value="labels" className="shrink-0">
            {t("tabs.labels")}
          </TabsTrigger>
          <TabsTrigger value="canned" className="shrink-0">
            {t("tabs.canned")}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="adapters" className="mt-4">
          <AdaptersTab />
        </TabsContent>
        <TabsContent value="conversations" className="mt-4">
          <ConversationsTab />
        </TabsContent>
        <TabsContent value="inbox" className="mt-4">
          <InboxTab />
        </TabsContent>
        <TabsContent value="outbound" className="mt-4">
          <OutboundTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4">
          <AuditTab />
        </TabsContent>
        <TabsContent value="capability" className="mt-4">
          <CapabilityMatrixTab />
        </TabsContent>
        <TabsContent value="labels" className="mt-4">
          <LabelsTab />
        </TabsContent>
        <TabsContent value="canned" className="mt-4">
          <CannedResponsesTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
