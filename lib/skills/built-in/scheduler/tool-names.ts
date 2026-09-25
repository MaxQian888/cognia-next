/**
 * The `schedule.*` family's MCP tool names, in one place.
 *
 * The skills register under these names, and three renderer surfaces key off
 * them: the chat's scheduler tool card, the desktop approval preview and the
 * build-options capability projection. A pure module (no registration side
 * effects) so a component can import it without pulling the skills in.
 */

export const SCHEDULE_TOOL = {
  list: "scheduler_list_tasks",
  inspect: "scheduler_inspect_task",
  create: "scheduler_create_task",
  update: "scheduler_update_task",
  setStatus: "scheduler_set_task_status",
  runNow: "scheduler_run_task_now",
  cancelRun: "scheduler_cancel_task_run",
  stopProcess: "scheduler_stop_task_process",
  delete: "scheduler_delete_task",
} as const

export type ScheduleToolVerb = keyof typeof SCHEDULE_TOOL
export type ScheduleToolName = (typeof SCHEDULE_TOOL)[ScheduleToolVerb]

export const SCHEDULE_TOOL_NAMES: readonly ScheduleToolName[] = Object.values(SCHEDULE_TOOL)

const VERB_BY_NAME = new Map<string, ScheduleToolVerb>(
  (Object.entries(SCHEDULE_TOOL) as [ScheduleToolVerb, ScheduleToolName][]).map(([verb, name]) => [
    name,
    verb,
  ])
)

/** The verb for a scheduler tool name (bare, prefix already folded), else `undefined`. */
export function scheduleToolVerb(toolName: string | undefined): ScheduleToolVerb | undefined {
  return toolName ? VERB_BY_NAME.get(toolName) : undefined
}
