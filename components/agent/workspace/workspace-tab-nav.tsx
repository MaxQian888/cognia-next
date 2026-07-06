"use client"

// Responsive tab navigation for the Agent Teams workspace.
//
// - Mobile (<sm): horizontal, icon-only strip that scrolls sideways.
// - Tablet (sm–lg): horizontal strip with icon + label.
// - Desktop (lg+): a vertical sidebar rail (icon + label, left-aligned) so the
//   workspace uses the available width instead of a single centered column.
//
// Presentational only — must render inside a `<Tabs>` (Radix context provides
// the active value + onValueChange). The values match the page's `ALL_TABS`.

import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  BarChart3Icon,
  MessageCircleIcon,
  Settings2Icon,
  ListTodoIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { TabsList, TabsTrigger } from "@/components/ui/tabs"

export const WORKSPACE_TABS: ReadonlyArray<{ value: string; icon: LucideIcon }> = [
  { value: "overview", icon: BarChart3Icon },
  { value: "tasks", icon: ListTodoIcon },
  { value: "chat", icon: MessageCircleIcon },
  { value: "activity", icon: ActivityIcon },
  { value: "members", icon: UsersIcon },
  { value: "settings", icon: Settings2Icon },
]

export function WorkspaceTabNav() {
  const tTabs = useTranslations("agentTeamsWorkspace.tabs")
  return (
    <div className="overflow-x-auto lg:sticky lg:top-0 lg:shrink-0 lg:self-start lg:overflow-visible">
      <TabsList className="inline-flex h-9 w-max gap-1 lg:h-auto lg:w-48 lg:flex-col lg:items-stretch lg:bg-transparent lg:p-0">
        {WORKSPACE_TABS.map(({ value, icon: Icon }) => (
          <TabsTrigger
            key={value}
            value={value}
            data-testid={`tab-${value}`}
            className="gap-1.5 lg:justify-start lg:px-3 lg:py-2"
          >
            <Icon className="size-3.5 shrink-0 lg:size-4" />
            <span className="hidden sm:inline">{tTabs(value)}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
  )
}
