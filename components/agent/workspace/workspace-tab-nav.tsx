"use client"

// Tab navigation for the Agent Teams workspace, built on the shadcn `Sidebar`.
//
// Renders a real collapsible sidebar rail (icon-collapsible via the header
// trigger or Ctrl/Cmd+B) instead of a hand-rolled vertical `TabsList`. It is
// navigation-only: the parent owns the active `value` + `onValueChange` (wired
// to the store's `workspaceTab`) and conditionally renders the matching panel.
// Must be mounted inside a `<SidebarProvider>`.

import { useTranslations } from "next-intl"
import type { AgentTeamWorkspaceTab } from "@/types/agent/agent-team"
import {
  ActivityIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  GitBranchIcon,
  ListTodoIcon,
  MessageCircleIcon,
  Settings2Icon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar"

export const WORKSPACE_TABS: ReadonlyArray<{ value: AgentTeamWorkspaceTab; icon: LucideIcon }> = [
  { value: "overview", icon: BarChart3Icon },
  { value: "tasks", icon: ListTodoIcon },
  { value: "chat", icon: MessageCircleIcon },
  { value: "activity", icon: ActivityIcon },
  { value: "worktrees", icon: GitBranchIcon },
  { value: "members", icon: UsersIcon },
  { value: "settings", icon: Settings2Icon },
]

export interface WorkspaceTabNavProps {
  /** Active tab value (matches the store's `workspaceTab`). */
  value: string
  /** Select a tab. */
  onValueChange: (value: string) => void
  /** Navigate back to the team list. */
  onBack: () => void
  /** Team name shown in the rail header (hidden when the rail collapses). */
  teamName?: string
  /** Optional per-tab count badges (e.g. `{ members: 3 }`). */
  counts?: Partial<Record<string, number>>
}

export function WorkspaceTabNav({
  value,
  onValueChange,
  onBack,
  teamName,
  counts,
}: WorkspaceTabNavProps) {
  const tTabs = useTranslations("agentTeamsWorkspace.tabs")
  const t = useTranslations("agentTeamsWorkspace")

  return (
    <Sidebar collapsible="icon" className="border-r">
      <SidebarHeader>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:hidden"
            onClick={onBack}
            aria-label={t("listTitle")}
            data-testid="workspace-back"
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold group-data-[collapsible=icon]:hidden">
            {teamName ?? t("listTitle")}
          </span>
          <SidebarTrigger className="shrink-0 group-data-[collapsible=icon]:mx-auto" />
        </div>
      </SidebarHeader>
      <SidebarSeparator className="group-data-[collapsible=icon]:hidden" />
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            {WORKSPACE_TABS.map(({ value: v, icon: Icon }) => {
              const count = counts?.[v]
              return (
                <SidebarMenuItem key={v}>
                  <SidebarMenuButton
                    isActive={value === v}
                    onClick={() => onValueChange(v)}
                    tooltip={tTabs(v)}
                    data-testid={`tab-${v}`}
                  >
                    <Icon />
                    <span>{tTabs(v)}</span>
                  </SidebarMenuButton>
                  {typeof count === "number" ? (
                    <SidebarMenuBadge data-testid={`tab-${v}-count`}>{count}</SidebarMenuBadge>
                  ) : null}
                </SidebarMenuItem>
              )
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  )
}
