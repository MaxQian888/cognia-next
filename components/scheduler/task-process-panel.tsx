"use client"

/**
 * "What is this task still running on my machine?"
 *
 * A scheduled `background-command` spawns a real OS process and its execution
 * completes in milliseconds, because the execution's job is to START the work.
 * So the run history showed a green tick while a build ran for twenty minutes,
 * and the schedule that started it had no idea. The only surface that listed
 * the process was the status-bar Job Center, which labelled its owner with a
 * raw task id.
 *
 * This is the other half of that: the processes, where the task that started
 * them lives, with the stop button next to them.
 *
 * Rendered only for the task types that can have processes at all
 * (`taskTypeSpawnsProcesses`), because an empty "Processes" heading under
 * every chat task would be noise. When the host has no supervisor the panel
 * says so rather than showing an empty list, since on a phone an empty list
 * reads as "the desktop's command finished".
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { SquareIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  cancelTaskMonitor,
  countLiveProcesses,
  isJobLive,
  isMonitorLive,
  killTaskJob,
  listTaskProcesses,
  taskTypeSpawnsProcesses,
  type TaskProcesses,
} from "@/lib/scheduler/task-processes"

/** Watched closely while something is alive, idly when nothing is. */
const POLL_LIVE_MS = 3_000
const POLL_IDLE_MS = 20_000

export interface TaskProcessPanelProps {
  taskId: string
  taskType: string
  /** Injected in tests so the suite does not need a process supervisor. */
  loadProcesses?: (task: { id: string; type: string }) => Promise<TaskProcesses>
  onKillJob?: (jobId: string) => Promise<unknown>
  onCancelMonitor?: (monitorId: string) => Promise<unknown>
}

export function TaskProcessPanel({
  taskId,
  taskType,
  loadProcesses = listTaskProcesses,
  onKillJob = killTaskJob,
  onCancelMonitor = cancelTaskMonitor,
}: TaskProcessPanelProps) {
  const t = useTranslations("scheduler.processes")
  const [processes, setProcesses] = useState<TaskProcesses | null>(null)
  const [stopping, setStopping] = useState<string | null>(null)

  const spawns = taskTypeSpawnsProcesses(taskType)

  const refresh = useCallback(async () => {
    const next = await loadProcesses({ id: taskId, type: taskType })
    setProcesses(next)
  }, [loadProcesses, taskId, taskType])

  useEffect(() => {
    if (!spawns) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Kept in the effect's own closure rather than in a ref, so the cadence is
    // decided from what this poll actually saw. Reading it back out of state
    // would race the render, and writing a ref during render is not allowed.
    let latest: TaskProcesses | null = null

    const tick = async () => {
      try {
        const next = await loadProcesses({ id: taskId, type: taskType })
        if (cancelled) return
        latest = next
        setProcesses(next)
      } catch {
        // `listTaskProcesses` already answers with a refusal rather than
        // throwing. Anything reaching here is a bug in the injected loader,
        // and a polling panel must not take the detail view down with it.
      }
      if (cancelled) return
      const live = latest ? countLiveProcesses(latest) : 0
      timer = setTimeout(tick, live > 0 ? POLL_LIVE_MS : POLL_IDLE_MS)
    }

    void tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [spawns, loadProcesses, taskId, taskType])

  if (!spawns) return null
  if (!processes) return null

  if (!processes.supported) {
    return (
      <section data-testid="task-process-panel" className="mt-5">
        <Heading title={t("title")} />
        <p className="text-xs text-muted-foreground" data-testid="task-process-unsupported">
          {processes.reason}
        </p>
      </section>
    )
  }

  const { jobs, monitors } = processes
  if (jobs.length === 0 && monitors.length === 0) {
    return (
      <section data-testid="task-process-panel" className="mt-5">
        <Heading title={t("title")} />
        <p className="text-xs text-muted-foreground" data-testid="task-process-empty">
          {t("none")}
        </p>
      </section>
    )
  }

  const stop = async (kind: "job" | "monitor", id: string) => {
    setStopping(id)
    try {
      if (kind === "job") await onKillJob(id)
      else await onCancelMonitor(id)
      toast.success(t("stopped"))
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("stopFailed"))
    } finally {
      setStopping(null)
    }
  }

  return (
    <section data-testid="task-process-panel" className="mt-5">
      <Heading title={t("title")} />
      <div className="flex flex-col gap-1.5">
        {jobs.map((job) => (
          <div
            key={job.id}
            data-testid="task-process-job"
            className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
          >
            <Badge variant={isJobLive(job) ? "default" : "outline"} className="shrink-0">
              {job.status}
            </Badge>
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[11px]">{job.command}</p>
              <p className="truncate text-[10px] text-muted-foreground">
                {/* The PID is the point of showing this at all: it is what a
                    user needs to go find the process outside the app. */}
                {job.pid !== undefined ? t("pid", { pid: job.pid }) : t("noPid")}
                {job.exitCode !== undefined ? ` · ${t("exitCode", { code: job.exitCode })}` : ""}
              </p>
            </div>
            {isJobLive(job) && (
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0"
                data-testid="task-process-kill"
                disabled={stopping === job.id}
                onClick={() => void stop("job", job.id)}
              >
                <SquareIcon className="size-3" />
                {t("stop")}
              </Button>
            )}
          </div>
        ))}

        {monitors.map((monitor) => (
          <div
            key={monitor.id}
            data-testid="task-process-monitor"
            className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5"
          >
            <Badge variant={isMonitorLive(monitor) ? "default" : "outline"} className="shrink-0">
              {monitor.status}
            </Badge>
            <p className="min-w-0 flex-1 truncate font-mono text-[11px]">
              {t("watching", { condition: monitor.condition.kind })}
            </p>
            {isMonitorLive(monitor) && (
              <Button
                variant="ghost"
                size="xs"
                className="shrink-0"
                data-testid="task-process-cancel-monitor"
                disabled={stopping === monitor.id}
                onClick={() => void stop("monitor", monitor.id)}
              >
                {t("stop")}
              </Button>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

function Heading({ title }: { title: string }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {title}
    </h3>
  )
}
