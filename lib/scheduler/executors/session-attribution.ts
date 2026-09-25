/**
 * Where a session a scheduled run CREATES belongs, and where it came from.
 *
 * The task's own workspace, not whichever one is active in the UI when the
 * timer fires: a task set up in one repo that fired while the user was in
 * another used to land its conversation there. The origin lets the chat
 * header say which task opened the conversation and link back to the task and
 * run on the scheduler page.
 *
 * Own module because both `executors/index.ts` and `goal-executor.ts` create
 * sessions, and the index already imports the goal executor.
 */

import type { ChatSession } from "@cognia/agent-config-types"
import type { ScheduledTask } from "@/types/scheduler"

export function scheduledSessionAttribution(
  task: Pick<ScheduledTask, "id" | "name" | "projectId">,
  runId?: string
): Pick<ChatSession, "origin"> & { projectId?: string } {
  return {
    ...(task.projectId ? { projectId: task.projectId } : {}),
    origin: {
      kind: "scheduled-task",
      taskId: task.id,
      taskName: task.name,
      ...(runId ? { runId } : {}),
    },
  }
}
