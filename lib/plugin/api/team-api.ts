/**
 * Plugin Agent-Team API — lets plugins read the team task board and perform
 * guarded task-level writes (feed tasks in from external trackers, comment
 * as a bot, move cards through the human-owned transitions). Modeled on
 * `goal-api.ts`.
 *
 * Design:
 *  - Reads/writes go through the `agent-team-store` — the single write
 *    source for teams/tasks (the same store the workspace kanban and the
 *    Companion RPCs use). No parallel data path.
 *  - `moveTask` is validated by the shared `canMoveTask` guard (via the
 *    store action), so a plugin can never push a transition the board UI
 *    would refuse; denials come back as `{ ok: false, reason }`.
 *  - Deliberately NO run control (`start`/`pause`/`resume`): starting a
 *    team consumes real tokens/compute — that stays a human (or Companion
 *    remote-control) decision. Plugins that need orchestration register
 *    workflow nodes / scheduler templates instead.
 *  - Gated by `team:read` (reads + subscribe) / `team:write` (mutations).
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { TaskMoveError } from "@/lib/ai/agent/team/task-move-guard"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import type {
  AgentTaskComment,
  AgentTeam,
  AgentTeammate,
  AgentTeamTask,
  TeamTaskStatus,
} from "@/types/agent/agent-team"

export interface PluginTeamTaskCreateInput {
  teamId: string
  title: string
  description?: string
  priority?: SubAgentPriority
  /** Teammate id — must belong to the team. */
  assignedTo?: string
  tags?: string[]
  /** Upstream task ids that must complete first. */
  dependencies?: string[]
}

export interface PluginTeamMoveResult {
  ok: boolean
  reason?: TaskMoveError
}

/** Agent-Team board API exposed to plugins. */
export interface PluginTeamAPI {
  // --------------------------------------------------------------- reads
  /** Every team (workspace-scoped store contents). */
  listTeams(): Promise<AgentTeam[]>
  /** One team by id, or `null`. */
  getTeam(teamId: string): Promise<AgentTeam | null>
  /** The team's roster. */
  listTeammates(teamId: string): Promise<AgentTeammate[]>
  /** The team's task board (unsorted; `order` is the column ordering). */
  listTasks(teamId: string): Promise<AgentTeamTask[]>
  /**
   * Observe a team's board. Fires on any change to the team row, its
   * roster, or its tasks; returns an unsubscribe. Gated by `team:read`
   * at subscription time.
   */
  subscribe(teamId: string, listener: () => void): () => void

  // ----------------------------------------------------------- mutations
  /** Create a pending task on the board. */
  createTask(input: PluginTeamTaskCreateInput): Promise<AgentTeamTask>
  /** Append a comment to a task's board thread (author = the plugin). */
  addComment(taskId: string, text: string): Promise<AgentTaskComment | null>
  /**
   * Move a task through the guarded board transitions (same `canMoveTask`
   * rules as the kanban drag). Never throws for a denial.
   */
  moveTask(taskId: string, to: TeamTaskStatus): Promise<PluginTeamMoveResult>
}

/**
 * Create the Team API for a plugin. Reads need `team:read`; mutations need
 * `team:write` (enforced via the PermissionGuard proxy).
 */
export function createTeamAPI(pluginId: string): PluginTeamAPI {
  const api: PluginTeamAPI = {
    // reads
    listTeams: async () => Object.values(useAgentTeamStore.getState().teams),
    getTeam: async (teamId) => useAgentTeamStore.getState().teams[teamId] ?? null,
    listTeammates: async (teamId) =>
      Object.values(useAgentTeamStore.getState().teammates).filter((m) => m.teamId === teamId),
    listTasks: async (teamId) =>
      Object.values(useAgentTeamStore.getState().tasks).filter((t) => t.teamId === teamId),
    subscribe: (teamId, listener) => {
      let prev = useAgentTeamStore.getState()
      return useAgentTeamStore.subscribe((state) => {
        const changed =
          state.teams[teamId] !== prev.teams[teamId] ||
          state.tasks !== prev.tasks ||
          state.teammates !== prev.teammates
        prev = state
        if (changed) listener()
      })
    },

    // mutations
    createTask: async (input) => {
      const state = useAgentTeamStore.getState()
      if (!state.teams[input.teamId]) {
        throw new Error(`ctx.team.createTask: team ${input.teamId} not found`)
      }
      if (input.assignedTo && state.teammates[input.assignedTo]?.teamId !== input.teamId) {
        throw new Error(`ctx.team.createTask: assignee ${input.assignedTo} is not on the team`)
      }
      return state.createTask({
        teamId: input.teamId,
        title: input.title,
        description: input.description ?? input.title,
        ...(input.priority ? { priority: input.priority } : {}),
        ...(input.assignedTo ? { assignedTo: input.assignedTo } : {}),
        tags: input.tags ?? [],
        dependencies: input.dependencies ?? [],
      })
    },
    addComment: async (taskId, text) =>
      useAgentTeamStore.getState().addTaskComment({
        taskId,
        // Attributed to the contributing plugin so the thread shows the actor.
        authorId: `plugin:${pluginId}`,
        authorName: pluginId,
        text,
      }),
    moveTask: async (taskId, to) => {
      const result = useAgentTeamStore.getState().moveTask(taskId, to)
      return result.ok ? { ok: true } : { ok: false, reason: result.reason ?? "task-not-found" }
    },
  }

  return createGuardedAPI(pluginId, api, {
    listTeams: "team:read",
    getTeam: "team:read",
    listTeammates: "team:read",
    listTasks: "team:read",
    subscribe: "team:read",
    createTask: "team:write",
    addComment: "team:write",
    moveTask: "team:write",
  })
}
