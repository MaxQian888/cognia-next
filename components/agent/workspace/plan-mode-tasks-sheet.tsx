"use client"

// Chat-header trigger that surfaces plan-mode tasks for a non-team chat
// session. Reuses `<AgentTeamTasks>` from the workspace UI so the rendering
// stays single-source: every place we show tasks goes through the same
// component. The synthetic team id (`solo:<sessionId>`) is created on
// first emit by `lib/agent/plan-mode-bridge.ts`.

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { ListTodoIcon } from "lucide-react"
import { useShallow } from "zustand/react/shallow"

import { Button } from "@/components/ui/button"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { soloTeamId } from "@/lib/agent/plan-mode-bridge"
import { AgentTeamTasks } from "./tasks"

export interface PlanModeTasksSheetProps {
  /** Active chat session id. The synthetic team id derives from this. */
  sessionId: string
  className?: string
}

export function PlanModeTasksSheet({ sessionId, className }: PlanModeTasksSheetProps) {
  const t = useTranslations("planModeTasks")
  const teamId = soloTeamId(sessionId)
  // Subscribe to the raw tasks map under shallow equality, then derive the
  // filtered list inside `useMemo`. Computing `Object.values(...).filter(...)`
  // directly in the selector returns a fresh array on every store tick and
  // sends Zustand's getSnapshot into an infinite loop.
  const allTasks = useAgentTeamStore(useShallow((s) => s.tasks))
  const tasks = useMemo(
    () => Object.values(allTasks).filter((task) => task.teamId === teamId),
    [allTasks, teamId]
  )
  // The synthetic team has no teammates; pass an empty array so the
  // assignee dropdown in the form renders "Unassigned" only.
  const teammates = useMemo(() => [], [])

  if (tasks.length === 0) return null

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={className}
          data-testid="plan-mode-tasks-trigger"
          aria-label={t("triggerLabel", { count: tasks.length })}
        >
          <ListTodoIcon className="mr-1.5 size-4" />
          <span className="text-xs">{t("triggerText", { count: tasks.length })}</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("headerTitle")}</SheetTitle>
          <SheetDescription>{t("headerDescription")}</SheetDescription>
        </SheetHeader>
        <div className="mt-4 px-4 pb-4">
          <AgentTeamTasks teamId={teamId} tasks={tasks} teammates={teammates} />
        </div>
      </SheetContent>
    </Sheet>
  )
}

export default PlanModeTasksSheet
