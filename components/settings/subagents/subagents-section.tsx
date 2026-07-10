"use client"

/**
 * SubagentsSection — settings shell for the SubAgent feature: templates
 * (persisted, fork-from-builtin) + runtime (ephemeral, reads from
 * `subagent-runtime-store`).
 *
 * Phase 6 of the ClaudeCode 完整化 plan.
 */

import { useCallback, useMemo } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { NetworkIcon } from "lucide-react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SettingsPageHeader } from "@/components/settings/common/settings-section"
import { SubagentTemplatesTab } from "./subagent-templates-tab"
import { SubagentRuntimeTab } from "./subagent-runtime-tab"
import { SubagentNestingCard } from "./subagent-nesting-card"
import { BackgroundTasksCard } from "./background-tasks-card"
import {
  CLAUDE_CODE_RELATED,
  RelatedSectionsStrip,
} from "@/components/settings/common/related-sections-strip"

type Tab = "templates" | "runtime"

export function SubagentsSection() {
  const t = useTranslations("settings.subagents")
  const router = useRouter()
  const searchParams = useSearchParams()

  const tab = useMemo<Tab>(() => {
    const v = searchParams?.get("subagentTab")
    return v === "runtime" ? "runtime" : "templates"
  }, [searchParams])

  const setTab = useCallback(
    (next: Tab) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "")
      params.set("subagentTab", next)
      router.replace(`?${params.toString()}`, { scroll: false })
    },
    [router, searchParams]
  )

  return (
    <div className="space-y-6" data-testid="subagents-section">
      <SettingsPageHeader
        icon={<NetworkIcon className="size-4" />}
        title={t("title")}
        description={t("description")}
      />

      <RelatedSectionsStrip current="subagents" targets={CLAUDE_CODE_RELATED} />

      <div className="rounded-lg border p-4">
        <SubagentNestingCard />
      </div>

      <div className="rounded-lg border p-4">
        <BackgroundTasksCard />
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="-mx-1 overflow-x-auto px-1">
          <TabsList className="w-max">
            <TabsTrigger value="templates" data-testid="subagent-tab-templates">
              {t("tabs.templates")}
            </TabsTrigger>
            <TabsTrigger value="runtime" data-testid="subagent-tab-runtime">
              {t("tabs.runtime")}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="templates" className="mt-4">
          <SubagentTemplatesTab />
        </TabsContent>
        <TabsContent value="runtime" className="mt-4">
          <SubagentRuntimeTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default SubagentsSection
