"use client"

// Tab navigation for the Agent Teams workspace, built on the shadcn `Sidebar`.
//
// Renders a real collapsible sidebar rail (icon-collapsible via the header
// trigger or Ctrl/Cmd+B) instead of a hand-rolled vertical `TabsList`. It is
// navigation-only: the parent owns the active `value` + `onValueChange` (wired
// to the store's `workspaceTab`) and conditionally renders the matching panel.
// Must be mounted inside a `<SidebarProvider>`.

import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { MOBILE_SPRING } from "@/lib/ui/motion"
import type { AgentTeamWorkspaceTab } from "@/types/agent/agent-team"
import {
  ActivityIcon,
  ArrowLeftIcon,
  BarChart3Icon,
  FileCode2Icon,
  GitBranchIcon,
  GaugeIcon,
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

/**
 * Shared-layout id for the active-tab pill. One element slides between the
 * eight stops instead of eight elements cross-fading, which is what makes the
 * jump legible — see `components/mobile/shell/mobile-tab-bar.tsx` for the same
 * idiom on the mobile bar.
 */
const INDICATOR_LAYOUT_ID = "agent-team-workspace-tab-indicator"

export const WORKSPACE_TABS: ReadonlyArray<{ value: AgentTeamWorkspaceTab; icon: LucideIcon }> = [
  { value: "overview", icon: BarChart3Icon },
  { value: "tasks", icon: ListTodoIcon },
  { value: "chat", icon: MessageCircleIcon },
  { value: "activity", icon: ActivityIcon },
  { value: "operations", icon: GaugeIcon },
  { value: "worktrees", icon: GitBranchIcon },
  { value: "editor", icon: FileCode2Icon },
  { value: "members", icon: UsersIcon },
  { value: "settings", icon: Settings2Icon },
]

/**
 * Per-tab live signal. `count` renders a numeric badge; `live` renders a pulsing
 * dot for "something is happening in here" where a number would be noise (an
 * ever-climbing event count tells you nothing actionable).
 */
export interface WorkspaceTabSignal {
  count?: number
  live?: boolean
}

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
  /**
   * Optional per-tab live signals, merged over `counts`. Only tabs that need
   * the operator's attention get one — an unread reply, or a tab where work is
   * actively happening. Everything else stays quiet on purpose: a rail where
   * six of eight rows carry a number stops being a signal.
   */
  signals?: Partial<Record<string, WorkspaceTabSignal>>
}

export function WorkspaceTabNav({
  value,
  onValueChange,
  onBack,
  teamName,
  counts,
  signals,
}: WorkspaceTabNavProps) {
  const tTabs = useTranslations("agentTeamsWorkspace.tabs")
  const t = useTranslations("agentTeamsWorkspace")
  // Under reduced motion the pill is dropped entirely rather than animated to
  // zero duration: `SidebarMenuButton isActive` already paints its own active
  // background, so the pill is pure decoration once it cannot slide.
  const reduce = useReducedMotion()

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
              const signal = signals?.[v]
              const count = signal?.count ?? counts?.[v]
              // A live dot is only worth showing on a tab you are not looking
              // at — otherwise it pulses at you about the thing on your screen.
              const showLive = Boolean(signal?.live) && value !== v
              return (
                <SidebarMenuItem key={v} className="relative">
                  {value === v && !reduce ? (
                    <motion.span
                      layoutId={INDICATOR_LAYOUT_ID}
                      className="absolute inset-0 -z-10 rounded-md bg-sidebar-accent"
                      transition={MOBILE_SPRING}
                      aria-hidden
                    />
                  ) : null}
                  <SidebarMenuButton
                    isActive={value === v}
                    onClick={() => onValueChange(v)}
                    tooltip={tTabs(v)}
                    data-testid={`tab-${v}`}
                  >
                    <span className="relative flex shrink-0 items-center">
                      <Icon />
                      {showLive ? (
                        <span
                          className="absolute -right-0.5 -top-0.5 flex size-1.5"
                          data-testid={`tab-${v}-live`}
                          aria-hidden
                        >
                          <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:animate-none" />
                          <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
                        </span>
                      ) : null}
                    </span>
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
