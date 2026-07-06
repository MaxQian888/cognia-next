"use client"

import type { ComponentType } from "react"
import { useTranslations } from "next-intl"
import { BarChart3Icon, PencilIcon, ShoppingBagIcon, SparklesIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
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

export function SkillPanelTabs({ className }: { className?: string }) {
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
      className={cn("border-b", className)}
    >
      {/* No `overflow-x-auto`: it would give the `w-fit` list unbounded width,
          so it renders at max-content and overflows a narrow pane — the source
          of the horizontal scrollbar under the tabs and the scroll-into-view
          "jitter" when a partially-hidden tab is clicked. Instead the triggers
          shrink to fit (min-w-0 + truncated labels): compact when there's room,
          gracefully narrowing when there isn't, never scrolling. */}
      <div className="mx-2 my-2 sm:mx-4">
        <TabsList className="max-w-full">
          {TAB_DEFS.map((tab) => {
            const Icon = tab.icon
            return (
              <TabsTrigger key={tab.id} value={tab.id} className="min-w-0 flex-initial text-xs">
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{t(tab.labelKey)}</span>
                {tab.id === "editor" && dirtyCount > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 shrink-0 px-1.5 text-[10px]">
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
