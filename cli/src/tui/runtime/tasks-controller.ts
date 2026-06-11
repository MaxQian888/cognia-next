/**
 * `/tasks` controller — browse and control the scheduler's tasks, reusing
 * `schedulerDb` (`getAllTasks` / `getTask` / `updateTask`) against the CLI-local
 * Dexie. List opens the generic select overlay; show renders a notice; pause /
 * resume flip the status. Triggering a run is desktop-only (the executors need
 * the Tauri runtime), so it is intentionally not exposed here.
 */
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import type { ScheduledTask } from "@/types/scheduler"

import { ensureCliDb } from "../../db/bootstrap"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface TasksDeps {
  dispatch: (action: TuiAction) => void
  ensureDb?: () => Promise<unknown>
  getAll?: () => Promise<ScheduledTask[]>
  get?: (id: string) => Promise<ScheduledTask | null>
  update?: (task: ScheduledTask) => Promise<void>
}

const dbOf = (d: TasksDeps) => d.ensureDb ?? (() => ensureCliDb())
const getter = (d: TasksDeps) => d.get ?? ((id: string) => schedulerDb.getTask(id))

function formatWhen(when: ScheduledTask["nextRunAt"]): string {
  if (!when) return "—"
  return when instanceof Date ? when.toISOString() : String(when)
}

export async function tasksList(deps: TasksDeps): Promise<void> {
  await dbOf(deps)()
  const rows = await (deps.getAll ?? (() => schedulerDb.getAllTasks()))()
  if (rows.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No scheduled tasks." })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Scheduled tasks",
      items: rows.map((t) => ({ id: t.id, label: truncate(t.name, 48), hint: t.status })),
      index: 0,
      onSelectCommand: "tasks show",
    },
  })
}

export async function tasksShow(id: string, deps: TasksDeps): Promise<void> {
  const key = id.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: "Usage: /tasks show <id>" })
    return
  }
  await dbOf(deps)()
  const task = await getter(deps)(key)
  if (!task) {
    deps.dispatch({ type: "NOTICE", message: `Task ${key} not found.` })
    return
  }
  const lines = [
    `${task.name} — ${task.status}`,
    `  type: ${task.type}`,
    `  runs: ${task.runCount} (${task.successCount} ok, ${task.failureCount} failed)`,
    `  next: ${formatWhen(task.nextRunAt)}`,
  ]
  if (task.lastError) lines.push(`  last error: ${truncate(task.lastError, 80)}`)
  deps.dispatch({ type: "NOTICE", message: lines.join("\n") })
}

async function setStatus(
  id: string,
  status: ScheduledTask["status"],
  verb: string,
  deps: TasksDeps
): Promise<void> {
  const key = id.trim()
  if (!key) {
    deps.dispatch({ type: "NOTICE", message: `Usage: /tasks ${verb.toLowerCase()} <id>` })
    return
  }
  await dbOf(deps)()
  const task = await getter(deps)(key)
  if (!task) {
    deps.dispatch({ type: "NOTICE", message: `Task ${key} not found.` })
    return
  }
  await (deps.update ?? ((t: ScheduledTask) => schedulerDb.updateTask(t)))({ ...task, status })
  deps.dispatch({ type: "NOTICE", message: `${verb} task ${key}.` })
}

export function tasksPause(id: string, deps: TasksDeps): Promise<void> {
  return setStatus(id, "paused", "Paused", deps)
}

export function tasksResume(id: string, deps: TasksDeps): Promise<void> {
  return setStatus(id, "active", "Resumed", deps)
}
