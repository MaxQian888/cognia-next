"use client"

// Tabbed shell for the A2UI settings section. The active tab is reflected
// in the URL via a scoped `?a2uiTab=` param so deep-links land on the right
// pane.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
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

export function A2UISection() {
  const t = useTranslations("settings.a2ui")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(A2UI_TAB_PARAM)
  const activeTab: A2UITabId = isA2UITab(requested) ? requested : "overview"

  const onTabChange = (value: string) => {
    if (!isA2UITab(value)) return
    const next = new URLSearchParams(searchParams.toString())
    next.set(A2UI_TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
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
