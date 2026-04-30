"use client"

import { useTranslations } from "next-intl"
import { BarChart3Icon, PencilIcon, ShoppingBagIcon, SparklesIcon } from "lucide-react"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useSkillsStore, type SkillPanelTab } from "@/stores/skills"

const TAB_DEFS: { id: SkillPanelTab; labelKey: string; icon: React.ElementType }[] = [
  { id: "my-skills", labelKey: "mySkills", icon: SparklesIcon },
  { id: "browse", labelKey: "browse", icon: ShoppingBagIcon },
  { id: "editor", labelKey: "editor", icon: PencilIcon },
  { id: "analytics", labelKey: "analytics", icon: BarChart3Icon },
]

export function SkillPanelTabs() {
  const t = useTranslations("skills.tabs")
  const activeTab = useSkillsStore((s) => s.activeTab)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as SkillPanelTab)}
      className="border-b"
    >
      <TabsList className="mx-4 my-2 self-start">
        {TAB_DEFS.map((tab) => {
          const Icon = tab.icon
          return (
            <TabsTrigger key={tab.id} value={tab.id} className="text-xs">
              <Icon className="mr-1.5 size-3.5" />
              {t(tab.labelKey)}
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}
