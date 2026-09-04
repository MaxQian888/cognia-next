"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { BarChart3Icon, PencilIcon, ShoppingBagIcon, SparklesIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { PanelTabStrip, type PanelTab } from "@/components/common/panel-tab-strip"
import { cn } from "@/lib/utils"
import { useSkillsStore, type SkillPanelTab } from "@/stores/skills"

const TAB_DEFS: { id: SkillPanelTab; labelKey: string; icon: PanelTab<SkillPanelTab>["icon"] }[] = [
  { id: "my-skills", labelKey: "mySkills", icon: SparklesIcon },
  { id: "browse", labelKey: "browse", icon: ShoppingBagIcon },
  { id: "editor", labelKey: "editor", icon: PencilIcon },
  { id: "analytics", labelKey: "analytics", icon: BarChart3Icon },
]

/**
 * Panel tab bar. The narrowing contract lives in `PanelTabStrip`, which this
 * file used to carry its own copy of.
 */
export function SkillPanelTabs({ className }: { className?: string }) {
  const t = useTranslations("skills.tabs")
  const activeTab = useSkillsStore((s) => s.activeTab)
  const setActiveTab = useSkillsStore((s) => s.setActiveTab)
  const dirtyCount = useSkillsStore(
    (s) => s.editorWorkspace.openFiles.filter((f) => f.draftContent !== f.savedContent).length
  )

  const tabs = useMemo<PanelTab<SkillPanelTab>[]>(
    () =>
      TAB_DEFS.map((tab) => ({
        id: tab.id,
        label: t(tab.labelKey),
        icon: tab.icon,
        badge:
          tab.id === "editor" && dirtyCount > 0 ? (
            <Badge variant="secondary" className="ml-1 h-4 shrink-0 px-1.5 text-[10px]">
              {dirtyCount}
            </Badge>
          ) : undefined,
      })),
    [t, dirtyCount]
  )

  return (
    <PanelTabStrip
      tabs={tabs}
      value={activeTab}
      onValueChange={setActiveTab}
      className={cn("border-b", className)}
      listWrapperClassName="mx-2 my-2 sm:mx-4"
    />
  )
}
