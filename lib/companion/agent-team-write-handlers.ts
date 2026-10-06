/**
 * TS dispatch arms for the Agent-Team board control RPCs (team-board CQRS).
 *
 * The mobile board is a read-only mirror of Dexie `agentTeamBoard` (v104);
 * these handlers are its write path back into the desktop's
 * agent-team-store — the single write source. Every move revalidates
 * through the SAME `canMoveTask` guard as the desktop kanban (the store's
 * `moveTask` applies it), so a phone can never push a transition the
 * desktop UI would refuse. Denials are normal `{ ok: false, reason }`
 * results, not thrown errors — the caller renders them as toasts.
 *
 * Wired into `dispatchCommand` in `lib/companion/desktop-write-source.ts`;
 * the Rust canonical remote-execution boundary enforces each command's
 * capability, approval lease, schema and idempotency before dispatch.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { loggers } from "@cognia/logging"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import type { TeamTaskStatus } from "@/types/agent/agent-team"
import type { StartSquadRunResult } from "@/lib/ai/agent/team/squad/start-squad-run"
import { sha256Hex } from "@/lib/share/hash"

const log = loggers.agent.child("team-rpc")

export type TeamRunStartResult = Omit<StartSquadRunResult, "reason"> & {
  reason?: StartSquadRunResult["reason"] | "invalid_payload" | "caller_device_required"
}

const LAUNCH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A live manual gesture on a paired device, admitted by the execution host. */
export async function handleTeamRunStart(
  payload: Record<string, unknown>
): Promise<TeamRunStartResult> {
  const teamId = readString(payload, "teamId")?.trim()
  const launchId = readString(payload, "launchId")
  if (
    !teamId ||
    !launchId ||
    !LAUNCH_UUID.test(launchId) ||
    (payload.goal !== undefined && typeof payload.goal !== "string") ||
    (payload.ultracode !== undefined && typeof payload.ultracode !== "boolean")
  )
    return { started: false, reason: "invalid_payload" }

  // This field is overwritten by Rust after authenticating the request. It is
  // absent from the public schema: a client cannot borrow another device ID.
  const callerDeviceId = readString(payload, "callerDeviceId")
  if (!callerDeviceId?.trim()) return { started: false, reason: "caller_device_required" }

  try {
    // Bound the identifier's size and namespace it by the authenticated device.
    // A refreshed consent lease changes the transport attempt, not the run.
    const runId = `squad-companion:${await sha256Hex(JSON.stringify([callerDeviceId, launchId.toLowerCase()]))}`
    const { startSquadRun } = await import("@/lib/ai/agent/team/squad/start-squad-run")
    return await startSquadRun({
      squadId: teamId,
      runId,
      goal: typeof payload.goal === "string" ? payload.goal : "",
      // The manual console has the same durable review channel as desktop.
      // `companion` would mean unattended and fail a required plan review.
      origin: "interactive",
      triggeredFrom: { source: "api", deviceId: callerDeviceId },
      ...(typeof payload.ultracode === "boolean" ? { ultracode: payload.ultracode } : {}),
    })
  } catch (error) {
    log.warn("team_run_start admission failed", { teamId, error })
    return { started: false, reason: "dispatch_error" }
  }
}

export interface TeamCommandResult {
  ok: boolean
  reason?: string
  taskId?: string
  commentId?: string
}

const TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "blocked",
  "claimed",
  "in_progress",
  "review",
  "completed",
  "failed",
  "cancelled",
])

const PRIORITIES: ReadonlySet<string> = new Set(["critical", "high", "normal", "low", "background"])

function readString(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function taskInTeam(teamId: string, taskId: string) {
  const task = useAgentTeamStore.getState().tasks[taskId]
  return task && task.teamId === teamId ? task : null
}

export async function handleTeamTaskMove(
  payload: Record<string, unknown>
): Promise<TeamCommandResult> {
  const teamId = readString(payload, "teamId")
  const taskId = readString(payload, "taskId")
  const to = readString(payload, "to")
  if (!teamId || !taskId || !to) return { ok: false, reason: "invalid-payload" }
  if (!TASK_STATUSES.has(to)) return { ok: false, reason: "invalid-status" }
  if (!taskInTeam(teamId, taskId)) return { ok: false, reason: "task-not-found" }
  // moveTask re-runs canMoveTask against the LIVE team status — the phone's
  // snapshot may be stale, so the guard here is authoritative.
  const result = useAgentTeamStore.getState().moveTask(taskId, to as TeamTaskStatus)
  return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "denied" }
}

export async function handleTeamTaskCreate(
  payload: Record<string, unknown>
): Promise<TeamCommandResult> {
  const teamId = readString(payload, "teamId")
  const title = readString(payload, "title")
  if (!teamId || !title) return { ok: false, reason: "invalid-payload" }
  const state = useAgentTeamStore.getState()
  if (!state.teams[teamId]) return { ok: false, reason: "team-not-found" }
  const priority = readString(payload, "priority")
  if (priority !== null && !PRIORITIES.has(priority)) {
    return { ok: false, reason: "invalid-priority" }
  }
  const assignedTo = readString(payload, "assignedTo")
  if (assignedTo && state.teammates[assignedTo]?.teamId !== teamId) {
    return { ok: false, reason: "assignee-not-on-team" }
  }
  const tags = Array.isArray(payload.tags)
    ? payload.tags.filter((t): t is string => typeof t === "string")
    : []
  const task = state.createTask({
    teamId,
    title,
    description: readString(payload, "description") ?? title,
    ...(priority ? { priority: priority as SubAgentPriority } : {}),
    ...(assignedTo ? { assignedTo } : {}),
    tags,
  })
  log.info("team_task_create via companion", { teamId, taskId: task.id })
  return { ok: true, taskId: task.id }
}

export async function handleTeamTaskComment(
  payload: Record<string, unknown>
): Promise<TeamCommandResult> {
  const teamId = readString(payload, "teamId")
  const taskId = readString(payload, "taskId")
  const text = readString(payload, "text")
  if (!teamId || !taskId || !text) return { ok: false, reason: "invalid-payload" }
  if (!taskInTeam(teamId, taskId)) return { ok: false, reason: "task-not-found" }
  const comment = useAgentTeamStore.getState().addTaskComment({
    taskId,
    authorId: "user",
    text,
  })
  return comment ? { ok: true, commentId: comment.id } : { ok: false, reason: "empty-comment" }
}

// `handleTeamRunPause` / `handleTeamRunResume` / `handleTeamRunStop` were
// retired with ADR-0169. Run control is `execution_run_control`
// (`lib/companion/execution-run-control-handler.ts`), and the old
// team-addressed commands answer `upgrade-required`.
