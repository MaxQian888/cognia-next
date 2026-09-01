/**
 * Plugin Agent-Team API — lets plugins read the team task board (including
 * run-lifecycle observation: status / events / execution reports /
 * checkpoints) and perform guarded plan-level writes (feed tasks in from
 * external trackers, patch and assign them, manage the non-lead roster,
 * comment as a bot, move cards through the human-owned transitions).
 * Modeled on `goal-api.ts`.
 *
 * Design:
 *  - Reads/writes go through the `agent-team-store` — the single write
 *    source for teams/tasks (the same store the workspace kanban and the
 *    Companion RPCs use). No parallel data path.
 *  - `moveTask` is validated by the shared `canMoveTask` guard (via the
 *    store action), so a plugin can never push a transition the board UI
 *    would refuse; denials come back as `{ ok: false, reason }`.
 *  - Run control lives here, gated SEPARATELY from the board writes.
 *    This module used to say it deliberately had none, on the grounds that
 *    starting a team spends real tokens and so must stay a human decision.
 *    That was never the shape of the product: `ctx.agent.runTeam` has always
 *    started a Squad, from an existing id or from an ad-hoc config the plugin
 *    invents, needing only `agent:dispatch`. So the strictest write here
 *    (`addTeammate`) was gated harder than conjuring and running a whole
 *    Squad, and the promise in this comment was one a reader could act on and
 *    be wrong. Starting takes `agent:dispatch`, matching `ctx.agent.runTeam`,
 *    and pause / resume / stop take `agent:control`, the permission that
 *    already means "control agent execution". Neither is a new name.
 *  - `start` goes through `startSquadRun`, the ADR-0140 funnel, so a
 *    plugin-started run gets the same run id convention, execution row and
 *    workspace stamp as one started from chat.
 *  - Board reads are gated by `team:read`, board writes by `team:write`.
 */

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { TaskMoveError } from "@/lib/ai/agent/team/task-move-guard"
import type { SubAgentPriority } from "@/types/agent/sub-agent"
import type {
  AgentTaskComment,
  AgentTeam,
  AgentTeamConfig,
  AgentTeamEvent,
  AgentTeammate,
  AgentTeamTask,
  TaskCommentAttachment,
  TeamExecutionCheckpoint,
  TeamExecutionReport,
  TeamStatus,
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

/**
 * Input for adding a teammate to an existing team. Plugins can only add
 * regular `"teammate"` members — the lead is synthesized at team creation
 * and is not a role a plugin may claim.
 */
export interface PluginTeamTeammateCreateInput {
  teamId: string
  name: string
  description?: string
  spawnPrompt?: string
  /** Specialization blurb surfaced on the roster card. */
  specialization?: string
}

/**
 * Whitelisted teammate patch — identity/prompt fields only. Run-owned fields
 * (`status` / `progress` / `currentTaskId` / token usage) are deliberately
 * excluded: those belong to the team runtime, exactly like the run-owned
 * task fields excluded from {@link PluginTeamTaskPatch}.
 */
export interface PluginTeamTeammatePatch {
  name?: string
  description?: string
  spawnPrompt?: string
  specialization?: string
}

/**
 * Whitelisted task patch. Status transitions go through {@link PluginTeamAPI.moveTask}
 * (guarded); run-owned fields (`status` / `result` / `error` / `claimedBy` /
 * timing) are not patchable by plugins.
 */
export interface PluginTeamTaskPatch {
  title?: string
  description?: string
  priority?: SubAgentPriority
  tags?: string[]
  expectedOutput?: string
  estimatedDuration?: number
  /** Upstream task ids that must complete first. */
  dependencies?: string[]
}

/** Run-lifecycle snapshot for a team — status plus the latest execution report. */
export interface PluginTeamRunStatus {
  teamId: string
  status: TeamStatus
  /** Latest unified execution report, or `null` before the first run. */
  report: TeamExecutionReport | null
}

/** Outcome of a plugin-initiated Squad run control call. */
export interface PluginTeamRunControlResult {
  ok: boolean
  /** Present when `ok` is false: `squad_not_found`, `dispatch_error`, ... */
  reason?: string
  /** The run id, when starting produced one. */
  runId?: string
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
  /** One teammate by id, or `null`. */
  getTeammate(teammateId: string): Promise<AgentTeammate | null>
  /** The team's task board (unsorted; `order` is the column ordering). */
  listTasks(teamId: string): Promise<AgentTeamTask[]>
  /**
   * Observe a team's board. Fires on any change to the team row, its
   * roster, or its tasks; returns an unsubscribe. Gated by `team:read`
   * at subscription time.
   */
  subscribe(teamId: string, listener: () => void): () => void

  // ------------------------------------------------ run observation (read)
  /**
   * Run-lifecycle snapshot: the team's `status` plus its latest execution
   * report. `null` when the team doesn't exist. Pull-style complement to the
   * `onTeam*` plugin hooks — usable by plugins that only hold `ctx.team`.
   */
  getRunStatus(teamId: string): Promise<PluginTeamRunStatus | null>
  /**
   * The in-store run event ring buffer (last ~100 events, oldest first)
   * filtered to one team — task claims, completions, teammate lifecycle.
   */
  listEvents(teamId: string): Promise<AgentTeamEvent[]>
  /** The latest unified execution report, or `null` before the first run. */
  getExecutionReport(teamId: string): Promise<TeamExecutionReport | null>
  /** Progress-ledger checkpoints of the latest execution report (`[]` when none). */
  listCheckpoints(teamId: string): Promise<TeamExecutionCheckpoint[]>

  // ----------------------------------------------------------- mutations
  /** Create a pending task on the board. */
  createTask(input: PluginTeamTaskCreateInput): Promise<AgentTeamTask>
  /**
   * Patch a task's plan-owned fields (title / description / priority / tags /
   * expected output / estimate / dependencies). Run-owned fields are not
   * patchable — status goes through {@link moveTask}.
   */
  updateTask(taskId: string, patch: PluginTeamTaskPatch): Promise<AgentTeamTask>
  /** Same-column reorder: place the task at `targetIndex` and renumber. */
  reorderTask(taskId: string, targetIndex: number): Promise<void>
  /** Assign (or reassign) a task to a teammate on the same team. */
  assignTask(taskId: string, teammateId: string): Promise<void>
  /** Append a comment to a task's board thread (author = the plugin). */
  addComment(taskId: string, text: string): Promise<AgentTaskComment | null>
  /** Attach an artifact / file / link reference to a task. */
  attachTaskFile(taskId: string, attachment: Omit<TaskCommentAttachment, "id">): Promise<void>
  /**
   * Move a task through the guarded board transitions (same `canMoveTask`
   * rules as the kanban drag). Never throws for a denial.
   */
  moveTask(taskId: string, to: TeamTaskStatus): Promise<PluginTeamMoveResult>
  /** Add a regular teammate to the roster (never the lead). */
  addTeammate(input: PluginTeamTeammateCreateInput): Promise<AgentTeammate>
  /** Patch a teammate's identity/prompt fields (whitelisted; never run state). */
  updateTeammate(teammateId: string, patch: PluginTeamTeammatePatch): Promise<AgentTeammate>
  /**
   * Remove a teammate from the roster. Returns `false` (no-op) for the lead
   * or an unknown id — mirroring the store guard.
   */
  removeTeammate(teammateId: string): Promise<boolean>
  /**
   * Replace the team's configuration (budget / governance / execution
   * pattern). Full-replace semantics, matching the store action; read the
   * current config via {@link getTeam} and patch client-side.
   */
  updateTeamConfig(teamId: string, config: AgentTeamConfig): Promise<void>
  /**
   * Turn a registered Squad template into a real Squad, with its roster and
   * pre-seeded tasks. `null` when no template carries that id.
   *
   * A plugin could already CONTRIBUTE a template through the
   * `agent-team-template` capability, and nothing could turn one into a Squad
   * except a person clicking the library. A blueprint that only a human can
   * build is not an automation surface.
   */
  instantiateTemplate(templateId: string): Promise<AgentTeam | null>

  // ------------------------------------------------- run control (dispatch)
  /**
   * Start a run. Fire-and-forget: resolves once the run is launched, not when
   * it settles. Progress is observed through {@link getRunStatus} /
   * {@link listEvents} or the `onTeam*` hooks.
   *
   * Requires `agent:dispatch`, the same permission `ctx.agent.runTeam` takes.
   */
  start(teamId: string, options?: { goal?: string }): Promise<PluginTeamRunControlResult>
  /** Pause a live run. Requires `agent:control`. */
  pause(teamId: string): Promise<PluginTeamRunControlResult>
  /** Resume a paused run over its not-yet-done tasks. Requires `agent:control`. */
  resume(teamId: string): Promise<PluginTeamRunControlResult>
  /** Stop a run for good. Requires `agent:control`. */
  stop(teamId: string): Promise<PluginTeamRunControlResult>
}

/**
 * Create the Team API for a plugin. Reads need `team:read`; mutations need
 * `team:write` (enforced via the PermissionGuard proxy).
 */
/**
 * One body for pause / resume / stop. Each is a distinct manager verb but the
 * same shape of call, and each already exists: the Companion write handlers
 * (`lib/companion/agent-team-write-handlers.ts`) have driven these from a
 * paired phone since ADR-0113, so nothing new is being taught to the runtime.
 */
async function runControl(
  teamId: string,
  verb: "pause" | "resume" | "shutdown"
): Promise<PluginTeamRunControlResult> {
  if (!useAgentTeamStore.getState().teams[teamId]) {
    return { ok: false, reason: "squad_not_found" }
  }
  try {
    const { agentTeamManager } = await import("@/lib/ai/agent/agent-team")
    await agentTeamManager[verb](teamId)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "dispatch_error" }
  }
}

export function createTeamAPI(pluginId: string): PluginTeamAPI {
  const api: PluginTeamAPI = {
    // reads
    listTeams: async () => Object.values(useAgentTeamStore.getState().teams),
    getTeam: async (teamId) => useAgentTeamStore.getState().teams[teamId] ?? null,
    listTeammates: async (teamId) =>
      Object.values(useAgentTeamStore.getState().teammates).filter((m) => m.teamId === teamId),
    getTeammate: async (teammateId) => useAgentTeamStore.getState().teammates[teammateId] ?? null,
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

    // run observation
    getRunStatus: async (teamId) => {
      const team = useAgentTeamStore.getState().teams[teamId]
      if (!team) return null
      return { teamId, status: team.status, report: team.executionReport ?? null }
    },
    listEvents: async (teamId) =>
      useAgentTeamStore.getState().events.filter((e) => e.teamId === teamId),
    getExecutionReport: async (teamId) =>
      useAgentTeamStore.getState().teams[teamId]?.executionReport ?? null,
    listCheckpoints: async (teamId) =>
      useAgentTeamStore.getState().teams[teamId]?.executionReport?.checkpoints ?? [],

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
    updateTask: async (taskId, patch) => {
      const state = useAgentTeamStore.getState()
      const task = state.tasks[taskId]
      if (!task) throw new Error(`ctx.team.updateTask: task ${taskId} not found`)
      // Re-project onto the whitelist so extra keys (e.g. `status`) smuggled
      // through a structurally-wider object literal never reach the store.
      const safe: PluginTeamTaskPatch = {
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.expectedOutput !== undefined ? { expectedOutput: patch.expectedOutput } : {}),
        ...(patch.estimatedDuration !== undefined
          ? { estimatedDuration: patch.estimatedDuration }
          : {}),
        ...(patch.dependencies !== undefined ? { dependencies: patch.dependencies } : {}),
      }
      state.updateTask(taskId, safe)
      return useAgentTeamStore.getState().tasks[taskId]
    },
    reorderTask: async (taskId, targetIndex) => {
      const state = useAgentTeamStore.getState()
      if (!state.tasks[taskId]) throw new Error(`ctx.team.reorderTask: task ${taskId} not found`)
      state.reorderTask(taskId, targetIndex)
    },
    assignTask: async (taskId, teammateId) => {
      const state = useAgentTeamStore.getState()
      const task = state.tasks[taskId]
      if (!task) throw new Error(`ctx.team.assignTask: task ${taskId} not found`)
      if (state.teammates[teammateId]?.teamId !== task.teamId) {
        throw new Error(`ctx.team.assignTask: assignee ${teammateId} is not on the team`)
      }
      state.assignTask(taskId, teammateId)
    },
    attachTaskFile: async (taskId, attachment) => {
      const state = useAgentTeamStore.getState()
      if (!state.tasks[taskId]) {
        throw new Error(`ctx.team.attachTaskFile: task ${taskId} not found`)
      }
      state.attachTaskFile(taskId, attachment)
    },
    addTeammate: async (input) => {
      const state = useAgentTeamStore.getState()
      if (!state.teams[input.teamId]) {
        throw new Error(`ctx.team.addTeammate: team ${input.teamId} not found`)
      }
      const teammate = state.addTeammate({
        teamId: input.teamId,
        name: input.name,
        description: input.description ?? input.name,
        // Plugins may only contribute regular members — never a lead.
        role: "teammate",
        ...(input.spawnPrompt ? { spawnPrompt: input.spawnPrompt } : {}),
      })
      if (input.specialization) {
        state.updateTeammate(teammate.id, { specialization: input.specialization })
        return useAgentTeamStore.getState().teammates[teammate.id]
      }
      return teammate
    },
    updateTeammate: async (teammateId, patch) => {
      const state = useAgentTeamStore.getState()
      if (!state.teammates[teammateId]) {
        throw new Error(`ctx.team.updateTeammate: teammate ${teammateId} not found`)
      }
      const safe: PluginTeamTeammatePatch = {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.spawnPrompt !== undefined ? { spawnPrompt: patch.spawnPrompt } : {}),
        ...(patch.specialization !== undefined ? { specialization: patch.specialization } : {}),
      }
      state.updateTeammate(teammateId, safe)
      return useAgentTeamStore.getState().teammates[teammateId]
    },
    removeTeammate: async (teammateId) => {
      const state = useAgentTeamStore.getState()
      const teammate = state.teammates[teammateId]
      if (!teammate) return false
      const team = state.teams[teammate.teamId]
      if (team?.leadId === teammateId) return false
      state.removeTeammate(teammateId)
      return useAgentTeamStore.getState().teammates[teammateId] === undefined
    },
    updateTeamConfig: async (teamId, config) => {
      const state = useAgentTeamStore.getState()
      if (!state.teams[teamId]) {
        throw new Error(`ctx.team.updateTeamConfig: team ${teamId} not found`)
      }
      state.updateTeamConfig(teamId, config)
    },
    instantiateTemplate: async (templateId) => {
      // Dynamic so `ctx.team` does not drag the template registry and the
      // instantiation helper into every plugin context that never asks.
      const [{ getAgentTeamTemplate }, { instantiateAgentTeamTemplate }] = await Promise.all([
        import("@/lib/plugin/registries/agent-team-template-registry"),
        import("@/lib/agent-team/instantiate-template"),
      ])
      const template = getAgentTeamTemplate(templateId)
      if (!template) return null
      const state = useAgentTeamStore.getState()
      return instantiateAgentTeamTemplate(template, {
        createTeam: state.createTeam,
        addTeammate: state.addTeammate,
        createTask: state.createTask,
      })
    },

    // run control
    start: async (teamId, options) => {
      if (!useAgentTeamStore.getState().teams[teamId]) {
        return { ok: false, reason: "squad_not_found" }
      }
      // The ADR-0140 funnel, not `agentTeamManager.start`, so a plugin-started
      // run gets the run id convention, the execution row and the workspace
      // stamp. No `session`: a plugin is not a conversation, so the run is
      // uncarded and says so on its row.
      const { startSquadRun } = await import("@/lib/ai/agent/team/start-squad-run")
      const result = await startSquadRun({
        squadId: teamId,
        goal: options?.goal ?? "",
        origin: "api",
        triggeredFrom: { source: "api" },
      })
      return {
        ok: result.started,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.runId ? { runId: result.runId } : {}),
      }
    },
    pause: async (teamId) => runControl(teamId, "pause"),
    resume: async (teamId) => runControl(teamId, "resume"),
    stop: async (teamId) => runControl(teamId, "shutdown"),
  }

  return createGuardedAPI(pluginId, api, {
    listTeams: "team:read",
    getTeam: "team:read",
    listTeammates: "team:read",
    getTeammate: "team:read",
    listTasks: "team:read",
    subscribe: "team:read",
    getRunStatus: "team:read",
    listEvents: "team:read",
    getExecutionReport: "team:read",
    listCheckpoints: "team:read",
    createTask: "team:write",
    updateTask: "team:write",
    reorderTask: "team:write",
    assignTask: "team:write",
    addComment: "team:write",
    attachTaskFile: "team:write",
    moveTask: "team:write",
    addTeammate: "team:write",
    updateTeammate: "team:write",
    removeTeammate: "team:write",
    updateTeamConfig: "team:write",
    instantiateTemplate: "team:write",
    // Starting spends tokens the way `ctx.agent.runTeam` does, and takes the
    // same permission. Pause / resume / stop are execution control, which
    // `agent:control` already names.
    start: "agent:dispatch",
    pause: "agent:control",
    resume: "agent:control",
    stop: "agent:control",
  })
}
