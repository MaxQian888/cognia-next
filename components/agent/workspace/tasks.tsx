"use client"

import { useTranslations } from "next-intl"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TASK_STATUS_CONFIG } from "@/types/agent/agent-team"
import type { AgentTeamTask } from "@/types/agent/agent-team"

export interface AgentTeamTasksProps {
  tasks: AgentTeamTask[]
}

export function AgentTeamTasks({ tasks }: AgentTeamTasksProps) {
  const t = useTranslations("agentTeamsWorkspace.tasks")
  if (tasks.length === 0) {
    return (
      <Card className="p-4 text-center text-xs text-muted-foreground" data-testid="tasks-empty">
        {t("empty")}
      </Card>
    )
  }
  return (
    <div className="space-y-2" data-testid="workspace-tasks">
      {tasks.map((task) => {
        const cfg = TASK_STATUS_CONFIG[task.status]
        return (
          <Card key={task.id} className="space-y-1 p-3" data-testid={`task-${task.id}`}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium">{task.title}</p>
              <Badge variant="outline" data-testid={`task-${task.id}-status`}>
                {cfg?.labelKey ?? task.status}
              </Badge>
            </div>
            {task.description && (
              <p className="line-clamp-2 text-xs text-muted-foreground">{task.description}</p>
            )}
            {task.error && <p className="text-xs text-destructive">{task.error}</p>}
            {task.result && (
              <p className="line-clamp-2 text-[11px] italic text-muted-foreground">{task.result}</p>
            )}
          </Card>
        )
      })}
    </div>
  )
}
