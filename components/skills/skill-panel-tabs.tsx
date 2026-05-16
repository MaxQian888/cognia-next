"use client"

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { BarChart3Icon, PencilIcon, ShoppingBagIcon, SparklesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSkillsStore, type SkillPanelTab } from "@/stores/skills"

const TAB_DEFS: {
  id: SkillPanelTab
  labelKey: string
  icon: ComponentType<{ className?: string }>
}[] = [
  { id: "my-skills", labelKey: "mySkills", icon: SparklesIcon },
  { id: "browse", labelKey: "browse", icon: ShoppingBagIcon },
  { id: "editor", labelKey: "editor", icon: PencilIcon },
  { id: "analytics", labelKey: "analytics", icon: BarChart3Icon },
]

export function SkillPanelTabs() {
  const t = useTranslations("skills.tabs")
  const activeTab = useSkillsStore((s) => s.activeTab)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const dirtyCount = useSkillsStore(
    (s) => s.editorWorkspace.openFiles.filter((f) => f.draftContent !== f.savedContent).length
  )

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as SkillPanelTab)}
      className="border-b"
    >
      <div className="mx-2 my-2 overflow-x-auto sm:mx-4">
        <TabsList className="self-start">
          {TAB_DEFS.map((tab) => {
            const Icon = tab.icon
            return (
              <TabsTrigger key={tab.id} value={tab.id} className="whitespace-nowrap text-xs">
                <Icon className="mr-1.5 size-3.5" />
                {t(tab.labelKey)}
                {tab.id === "editor" && dirtyCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 px-1.5 text-[10px]">
                    {dirtyCount}
                  </Badge>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>
      </div>
    </Tabs>
  )
}
