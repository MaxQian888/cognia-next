"use client"

// Built-in Agent Runtime — top-level tabbed shell for the in-process Claude
// SDK runtime. Mirrors `data-section.tsx`'s URL-tab pattern with a private
// `?agentRuntimeTab=` param so deep-linking lands on the right tab.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { WorkflowIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DefaultsTab } from "./tabs/defaults-tab"
import { PermissionsToolsTab } from "./tabs/permissions-tools-tab"
import { SidecarTab } from "./tabs/sidecar-tab"
import { A2UIBridgeTab } from "./tabs/a2ui-bridge-tab"
import { SessionsTab } from "./tabs/sessions-tab"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"

const TAB_PARAM = "agentRuntimeTab"

export type AgentRuntimeTabId = "defaults" | "permissions" | "sidecar" | "sessions" | "a2ui"

const TAB_IDS: AgentRuntimeTabId[] = ["defaults", "permissions", "sessions", "sidecar", "a2ui"]

function isTab(value: string | null): value is AgentRuntimeTabId {
  return !!value && (TAB_IDS as string[]).includes(value)
}

export function AgentRuntimeSection() {
  const t = useTranslations("settings.agentRuntimeSection")
  const router = useRouter()
  const params = useSearchParams()
  const requested = params.get(TAB_PARAM)
  const activeTab: AgentRuntimeTabId = isTab(requested) ? requested : "defaults"

  const onTabChange = (value: string) => {
    if (!isTab(value)) return
    const next = new URLSearchParams(params.toString())
    next.set(TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <WorkflowIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <RelatedSectionsStrip current="agent-runtime" targets={CLAUDE_CODE_RELATED} />

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="defaults">{t("tabs.defaults")}</TabsTrigger>
            <TabsTrigger value="permissions">{t("tabs.permissions")}</TabsTrigger>
            <TabsTrigger value="sessions">{t("tabs.sessions")}</TabsTrigger>
            <TabsTrigger value="sidecar">{t("tabs.sidecar")}</TabsTrigger>
            <TabsTrigger value="a2ui">{t("tabs.a2ui")}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="defaults" className="mt-4">
          <DefaultsTab />
        </TabsContent>
        <TabsContent value="permissions" className="mt-4">
          <PermissionsToolsTab />
        </TabsContent>
        <TabsContent value="sessions" className="mt-4">
          <SessionsTab />
        </TabsContent>
        <TabsContent value="sidecar" className="mt-4">
          <SidecarTab />
        </TabsContent>
        <TabsContent value="a2ui" className="mt-4">
          <A2UIBridgeTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default AgentRuntimeSection
