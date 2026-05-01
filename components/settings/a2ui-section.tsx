"use client"

// Tabbed shell for the A2UI settings section. Mirrors `data/data-section.tsx`
// — useSyncExternalStore + a scoped `?a2uiTab=` URL param so deep-links land
// on the right pane.

import { useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { BlocksIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { OverviewTab } from "./a2ui/overview-tab"
import { RuntimeTab } from "./a2ui/runtime-tab"
import { TemplatesTab } from "./a2ui/templates-tab"
import { McpBridgeTab } from "./a2ui/mcp-bridge-tab"
import { DebuggerTab } from "./a2ui/debugger-tab"

const A2UI_TAB_PARAM = "a2uiTab"

export type A2UITabId = "overview" | "runtime" | "templates" | "mcpBridge" | "debugger"

const TAB_IDS: A2UITabId[] = ["overview", "runtime", "templates", "mcpBridge", "debugger"]

function isA2UITab(value: string | null): value is A2UITabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

const noopSubscribe = () => () => {}

function readTabFromUrl(): A2UITabId {
  if (typeof window === "undefined") return "overview"
  const params = new URLSearchParams(window.location.search)
  const requested = params.get(A2UI_TAB_PARAM)
  return isA2UITab(requested) ? requested : "overview"
}

export function A2UISection() {
  const t = useTranslations("settings.a2ui")
  const initialTab = useSyncExternalStore(
    noopSubscribe,
    readTabFromUrl,
    () => "overview" as A2UITabId
  )
  const [userTab, setUserTab] = useState<A2UITabId | null>(null)
  const activeTab = userTab ?? initialTab

  const onTabChange = (value: string) => {
    if (!isA2UITab(value)) return
    setUserTab(value)
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href)
      url.searchParams.set(A2UI_TAB_PARAM, value)
      window.history.replaceState({}, "", url.toString())
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <BlocksIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
          <TabsTrigger value="runtime">{t("tabs.runtime")}</TabsTrigger>
          <TabsTrigger value="templates">{t("tabs.templates")}</TabsTrigger>
          <TabsTrigger value="mcpBridge">{t("tabs.mcpBridge")}</TabsTrigger>
          <TabsTrigger value="debugger">{t("tabs.debugger")}</TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="runtime" className="mt-4">
          <RuntimeTab />
        </TabsContent>
        <TabsContent value="templates" className="mt-4">
          <TemplatesTab />
        </TabsContent>
        <TabsContent value="mcpBridge" className="mt-4">
          <McpBridgeTab />
        </TabsContent>
        <TabsContent value="debugger" className="mt-4">
          <DebuggerTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
