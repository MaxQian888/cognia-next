"use client"

// Built-in skills settings entry (ADR-0026).
//
// Tabbed shell — v1 ships the Lark tab only; placeholder tabs for future
// platforms (Slack, Discord) keep the schema in place without committing
// to UI ahead of those families landing.

import { useTranslations } from "next-intl"
import { useRouter, useSearchParams } from "next/navigation"
import { SparklesIcon } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LarkTab } from "./lark-tab"

const TAB_PARAM = "builtInSkillsTab"

export type BuiltInSkillsTabId = "lark"

export function BuiltInSkillsSection() {
  const t = useTranslations("settings.builtInSkills")
  const router = useRouter()
  const searchParams = useSearchParams()
  const requested = searchParams.get(TAB_PARAM)
  const activeTab: BuiltInSkillsTabId = requested === "lark" ? "lark" : "lark"

  const onTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set(TAB_PARAM, value)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <Label className="flex items-center gap-2">
          <SparklesIcon className="size-4" />
          {t("title")}
        </Label>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      <Tabs value={activeTab} onValueChange={onTabChange}>
        <TabsList className="w-max">
          <TabsTrigger value="lark">{t("tabs.lark")}</TabsTrigger>
        </TabsList>
        <TabsContent value="lark" className="mt-4">
          <LarkTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
