"use client"

/**
 * Which Workspace this schedule belongs to, and the way to change it.
 *
 * `ScheduledTask.projectId` was resolved once at creation and was not writable
 * through any update path, so a schedule attributed to the wrong workspace was
 * invisible from every other one and uncorrectable from the one that owned it.
 * The refusals come from `planTaskMove`. This owns the write.
 *
 * The binding is rendered even where it cannot be changed. A control that
 * disappears on a paired host would leave the user unable to see the value at
 * all, which is the worse half of the original problem.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { planTaskMove } from "@/lib/scheduler/move-task-workspace"
import { useSchedulerHostTarget } from "@/hooks/scheduler/use-scheduler-host-target"
import { useSchedulerStore } from "@/stores/scheduler/scheduler-store"
import { useProjectStore } from "@/stores/project/project-store"
import type { ScheduledTask } from "@/types/scheduler"

/**
 * Radix refuses an empty string as an item value, and "no workspace" is a real
 * choice rather than the absence of one, so it needs a value of its own.
 */
const UNBOUND = "__unbound__"

export interface TaskWorkspaceMoveProps {
  task: ScheduledTask
}

export function TaskWorkspaceMove({ task }: TaskWorkspaceMoveProps) {
  const t = useTranslations("scheduler.workspaceMove")
  const projects = useProjectStore((s) => s.projects)
  const updateTask = useSchedulerStore((s) => s.updateTask)
  // Scoped to the selected task's loaded executions, which is exactly what the
  // detail view this control lives in has already fetched.
  const running = useSchedulerStore((s) =>
    s.executions.some((run) => run.taskId === task.id && run.status === "running")
  )
  const [busy, setBusy] = useState(false)

  // Reactive, not a render-time read of the data source. The user can flip the
  // scheduler between this device and a paired host from the host bar, and a
  // module-variable read would leave this control describing the previous one.
  const { target: hostTarget } = useSchedulerHostTarget()
  const remoteHost = hostTarget !== "local"
  const available = useMemo(() => projects.filter((p) => !p.isArchived), [projects])

  /**
   * A task can point at a workspace that was archived or deleted. Radix renders
   * an EMPTY trigger for a value with no matching item, so the dangling id gets
   * an item of its own rather than being silently blanked. Naming the id the
   * task actually holds is the only way the user can tell "unbound" apart from
   * "bound to something that is gone".
   */
  const dangling =
    task.projectId && !available.some((p) => p.id === task.projectId) ? task.projectId : null

  async function move(next: string) {
    const targetId = next === UNBOUND ? null : next
    const plan = planTaskMove({
      task,
      target: targetId ? (available.find((p) => p.id === targetId) ?? null) : null,
      remoteHost,
      running,
    })
    if (!plan.ok) {
      toast.error(t(`refused.${plan.reason}`))
      return
    }
    setBusy(true)
    try {
      await updateTask(task.id, { projectId: plan.projectId })
      toast.success(plan.projectId ? t("moved") : t("cleared"))
    } catch (error) {
      toast.error(t("failed", { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setBusy(false)
    }
  }

  const disabledReason = remoteHost
    ? t("refused.remote-host")
    : running
      ? t("refused.task-running")
      : undefined

  return (
    <div className="flex flex-col gap-1" data-testid="task-workspace-move">
      <Select
        value={task.projectId ?? UNBOUND}
        disabled={busy || Boolean(disabledReason)}
        onValueChange={(next) => void move(next)}
      >
        <SelectTrigger aria-label={t("label")} size="sm" title={disabledReason}>
          <SelectValue placeholder={t("placeholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNBOUND}>{t("unbound")}</SelectItem>
          {available.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name || project.id}
            </SelectItem>
          ))}
          {dangling ? (
            <SelectItem value={dangling} disabled>
              {t("missingWorkspace", { id: dangling })}
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">{disabledReason ?? t("hint")}</p>
    </div>
  )
}
