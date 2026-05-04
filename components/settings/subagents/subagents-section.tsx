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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { SubagentTemplatesTab } from "./subagent-templates-tab"
import { SubagentRuntimeTab } from "./subagent-runtime-tab"

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
    <div className="space-y-4" data-testid="subagents-section">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">{t("title")}</h2>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="templates" data-testid="subagent-tab-templates">
            {t("tabs.templates")}
          </TabsTrigger>
          <TabsTrigger value="runtime" data-testid="subagent-tab-runtime">
            {t("tabs.runtime")}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="pt-2">
        {tab === "templates" ? <SubagentTemplatesTab /> : <SubagentRuntimeTab />}
      </div>
    </div>
  )
}

export default SubagentsSection
