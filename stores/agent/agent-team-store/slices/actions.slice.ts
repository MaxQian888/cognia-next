import type { StoreApi } from "zustand"
import { nanoid } from "nanoid"
import {
  type AgentTeam,
  type AgentTeammate,
  type AgentTeamTask,
  type AgentTaskComment,
  type TaskCommentAttachment,
  type AgentTeamMessage,
  type AgentTeamConfig,
  type AgentTeamTemplate,
  type TeamDelegationRecord,
} from "@/types/agent/agent-team"
import { normalizeAgentTeamConfig, normalizeAgentTeamTask } from "@/lib/ai/agent/agent-team-compat"
import { assertNoNewRawTeammateCredentials } from "@/lib/ai/agent/team/execution-binding-resolver"
import { canMoveTask, reorderColumn, sortColumn } from "@/lib/ai/agent/team/task-move-guard"
import { assignAgentTeamAvatarId, resolveAgentTeamAvatarId } from "@/lib/agent-team/avatar"
import { loggers } from "@cognia/logging"
import { useProjectStore } from "@/stores/project/project-store"
import { DEFAULT_PROJECT_ID } from "@/lib/db/project-defaults"
import { initialState, builtInTemplatesMap } from "../initial-state"
import type { AgentTeamState } from "../types"

const agentTeamLogger = loggers.agent.child("team-store")

type AgentTeamStoreSet = StoreApi<AgentTeamState>["setState"]
type AgentTeamStoreGet = StoreApi<AgentTeamState>["getState"]

type AgentTeamActions = Omit<AgentTeamState, keyof typeof initialState>

const ensureIdExactlyOnce = (ids: string[], id: string): string[] => {
  let seen = false
  const deduped: string[] = []

  for (const existingId of ids) {
    if (existingId === id) {
      if (seen) continue
      seen = true
    }
    deduped.push(existingId)
  }

  if (!seen) {
    deduped.push(id)
  }

  return deduped
}

const removeId = (ids: string[], id: string): string[] =>
  ids.filter((existingId) => existingId !== id)

/**
 * Force every still-running teammate of a team to `shutdown`.
 *
 * A module helper rather than a store action: its only caller is `deleteTeam`,
 * which shuts the roster down before it drops the rows. It was a public action
 * for the retired `/agent-teams/workspace` batch bar, and nothing outside this
 * file has called it since ADR-0140 took that surface out.
 */
function shutDownTeammates(
  state: AgentTeamState,
  teamId: string
): Partial<AgentTeamState> | AgentTeamState {
  const team = state.teams[teamId]
  if (!team) return state

  const updatedTeammates = { ...state.teammates }
  for (const id of team.teammateIds) {
    const tm = updatedTeammates[id]
    if (tm && tm.status !== "shutdown" && tm.status !== "completed" && tm.status !== "failed") {
      updatedTeammates[id] = { ...tm, status: "shutdown", currentTaskId: undefined }
    }
  }
  return { teammates: updatedTeammates }
}

/**
 * Drop a team and everything keyed to it: roster, tasks, messages, consensus,
 * shared memory, delegations and the persisted Editor session.
 *
 * Also a module helper for the same reason as `shutDownTeammates` — `deleteTeam`
 * is the only caller. Keeping it on the public state surface after the
 * workspace batch bar went would have left an unreferenced second way to
 * delete a team, one that skips `deleteTeam`'s durable-runtime purge.
 */
function cleanUpTeam(
  state: AgentTeamState,
  teamId: string
): Partial<AgentTeamState> | AgentTeamState {
  const team = state.teams[teamId]
  if (!team) return state

  const { [teamId]: _, ...restTeams } = state.teams

  const restTeammates = { ...state.teammates }
  for (const id of team.teammateIds) {
    delete restTeammates[id]
  }

  const restTasks = { ...state.tasks }
  for (const id of team.taskIds) {
    delete restTasks[id]
  }

  const restMessages = { ...state.messages }
  for (const id of team.messageIds) {
    delete restMessages[id]
  }

  // Clean consensus entries belonging to this team
  const restConsensus = { ...state.consensus }
  for (const [id, c] of Object.entries(restConsensus)) {
    if (c.teamId === teamId) delete restConsensus[id]
  }

  // Clean shared memory for this team
  const { [teamId]: _sm, ...restSharedMemory } = state.sharedMemory

  // Clean delegations belonging to this team
  const restDelegations = { ...state.delegations }
  for (const [id, d] of Object.entries(restDelegations)) {
    if (d.sourceTeamId === teamId) delete restDelegations[id]
  }

  // Drop the team's persisted project-Editor session.
  const { [teamId]: _es, ...restEditorSession } = state.editorSession

  return {
    teams: restTeams,
    teammates: restTeammates,
    tasks: restTasks,
    messages: restMessages,
    consensus: restConsensus,
    sharedMemory: restSharedMemory,
    delegations: restDelegations,
    editorSession: restEditorSession,
    activeTeamId: state.activeTeamId === teamId ? null : state.activeTeamId,
  }
}

export const createAgentTeamActionsSlice = (
  set: AgentTeamStoreSet,
  get: AgentTeamStoreGet
): AgentTeamActions => ({
  // ====================================================================
  // Team CRUD
  // ====================================================================

  createTeam: (input) => {
    const config: AgentTeamConfig = normalizeAgentTeamConfig({
      ...get().defaultConfig,
      ...input.config,
      preferredExecutionPattern: input.config?.preferredExecutionPattern,
      governancePolicy: input.config?.governancePolicy,
    })

    const teamId = nanoid()

    // Create lead. UI is expected to pass `input.leadName` /
    // `input.leadDescription` resolved via i18n; the store keeps the
    // resolved literal so re-renders don't need a translator.
    const lead: AgentTeammate = {
      id: nanoid(),
      teamId,
      name: input.leadName ?? "Team Lead",
      description:
        input.leadDescription ?? "Coordinates team work, assigns tasks, and synthesizes results",
      role: "lead",
      avatarId: "coordinator",
      status: "idle",
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    }

    const team: AgentTeam = {
      id: teamId,
      // Workspace isolation (Dexie v86): a live team belongs to the active
      // workspace. Reusable templates stay profile-shared (no projectId).
      projectId: useProjectStore.getState().activeProjectId ?? undefined,
      name: input.name,
      description: input.description || "",
      task: input.task,
      status: "idle",
      config,
      selectedExecutionPattern: config.preferredExecutionPattern,
      leadId: lead.id,
      teammateIds: [lead.id],
      taskIds: [],
      messageIds: [],
      progress: 0,
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      createdAt: new Date(),
      sessionId: input.sessionId,
      metadata: input.metadata,
    }

    set((state) => ({
      teams: { ...state.teams, [teamId]: team },
      teammates: { ...state.teammates, [lead.id]: lead },
      activeTeamId: teamId,
    }))

    return team
  },

  /**
   * Copy a squad, roster and tasks included, into a workspace.
   *
   * There was no squad-to-squad copy at all. `saveAsTemplate` went one way and
   * `instantiateAgentTeamTemplate` came back, so the only route from "this
   * squad, but for the other repo" was to publish a template and re-instantiate
   * it, which loses everything a template deliberately drops: the lead's own
   * configuration, per-teammate models, task ordering.
   *
   * `projectId` is a parameter rather than always the active workspace, which
   * is what makes this "copy into that workspace" as well as "copy here". Now
   * that the column is a real Dexie boundary rather than a filter, that is a
   * move between two places rather than a relabel.
   */
  duplicateSquad: (teamId, input) => {
    const state = get()
    const source = state.teams[teamId]
    if (!source) return null

    const nextTeamId = nanoid()
    const now = new Date()
    // Old id to new, so `leadId`, `teammateIds` and each task's `assignedTo`
    // point at the copies rather than back at the original's roster.
    const teammateIdMap = new Map<string, string>()
    const teammates: AgentTeammate[] = source.teammateIds
      .map((id) => state.teammates[id])
      .filter((member): member is AgentTeammate => member !== undefined)
      .map((member) => {
        const id = nanoid()
        teammateIdMap.set(member.id, id)
        return {
          ...member,
          id,
          teamId: nextTeamId,
          // A copy has done no work yet. Carrying progress across would show a
          // brand new squad as part-finished.
          status: "idle",
          completedTaskIds: [],
          tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          progress: 0,
          createdAt: now,
        } as AgentTeammate
      })

    const tasks: AgentTeamTask[] = source.taskIds
      .map((id) => state.tasks[id])
      .filter((task): task is AgentTeamTask => task !== undefined)
      .map((task) => {
        const assignedTo = task.assignedTo ? teammateIdMap.get(task.assignedTo) : undefined
        const { completedAt: _completedAt, startedAt: _startedAt, ...rest } = task
        return {
          ...rest,
          id: nanoid(),
          teamId: nextTeamId,
          status: "pending",
          ...(assignedTo ? { assignedTo } : { assignedTo: undefined }),
          createdAt: now,
        } as AgentTeamTask
      })

    const team: AgentTeam = {
      ...source,
      id: nextTeamId,
      name: input.name,
      projectId: input.projectId ?? source.projectId,
      // A copy starts idle with no history: statuses, run linkage and the
      // session it was bound to all belong to the original.
      status: "idle",
      progress: 0,
      totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      leadId: teammateIdMap.get(source.leadId) ?? source.leadId,
      teammateIds: teammates.map((member) => member.id),
      taskIds: tasks.map((task) => task.id),
      messageIds: [],
      createdAt: now,
      sessionId: undefined,
      completedAt: undefined,
      routingAssessment: undefined,
      dispatchDecision: undefined,
      externalPickup: undefined,
    }

    set((current) => ({
      teams: { ...current.teams, [nextTeamId]: team },
      teammates: {
        ...current.teammates,
        ...Object.fromEntries(teammates.map((member) => [member.id, member])),
      },
      tasks: { ...current.tasks, ...Object.fromEntries(tasks.map((task) => [task.id, task])) },
    }))

    return team
  },

  upsertTeam: (team) => {
    set((state) => ({
      teams: { ...state.teams, [team.id]: team },
    }))
  },

  updateTeam: (teamId, updates) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state
      const next = { ...team, ...updates }
      // Every team belongs to a workspace (persist v7). A row that somehow
      // still lacks one is stamped on its next save rather than left to leak
      // across workspaces.
      if (!next.projectId) {
        next.projectId = useProjectStore.getState().activeProjectId ?? DEFAULT_PROJECT_ID
      }
      return {
        teams: { ...state.teams, [teamId]: next },
      }
    })
  },

  updateTeamCapabilities: (teamId, bundle) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state
      return {
        teams: {
          ...state.teams,
          [teamId]: {
            ...team,
            config: { ...team.config, capabilities: bundle },
          },
        },
      }
    })
  },

  updateTeamConfig: (teamId, config) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state
      const executionModeChanged = config.executionMode !== team.config.executionMode
      const legacyGovernanceChanged =
        config.requirePlanApproval !== team.config.requirePlanApproval ||
        config.tokenBudget !== team.config.tokenBudget
      const normalizedConfig = normalizeAgentTeamConfig({
        ...config,
        preferredExecutionPattern:
          executionModeChanged &&
          config.preferredExecutionPattern === team.config.preferredExecutionPattern
            ? undefined
            : config.preferredExecutionPattern,
        governancePolicy:
          legacyGovernanceChanged && config.governancePolicy === team.config.governancePolicy
            ? undefined
            : config.governancePolicy,
      })
      return {
        teams: {
          ...state.teams,
          [teamId]: {
            ...team,
            config: normalizedConfig,
            selectedExecutionPattern: normalizedConfig.preferredExecutionPattern,
          },
        },
      }
    })
  },

  deleteTeam: (teamId) => {
    const team = get().teams[teamId]
    if (!team) return
    // Guard: check all non-lead teammates are idle/shutdown/completed/failed (OCC pattern)
    const state = get()
    const terminalStatuses = new Set(["idle", "shutdown", "completed", "failed"])
    const activeMembers = team.teammateIds
      .map((id) => state.teammates[id])
      .filter((tm) => tm && tm.role !== "lead" && !terminalStatuses.has(tm.status))
    if (activeMembers.length > 0) {
      // Shutdown active teammates first, then cleanup
      set((current) => shutDownTeammates(current, teamId))
    }
    set((current) => cleanUpTeam(current, teamId))
    if (team.config.runtimeVersion === "durable-v2") {
      void import("@/lib/db/agent-team-runtime")
        .then(({ purgeAgentTeam }) => purgeAgentTeam(teamId))
        .catch(() => undefined)
    }
  },

  purgeProject: (projectId) => {
    // Workspace isolation cascade (Dexie v86): drop every team owned by the
    // deleted workspace, plus its teammates + tasks. Templates are
    // profile-shared and left untouched. Called by `deleteProjectCascade`.
    set((state) => {
      const removedTeamIds = new Set<string>()
      const teams: Record<string, AgentTeam> = {}
      for (const [id, team] of Object.entries(state.teams)) {
        if (team.projectId === projectId) removedTeamIds.add(id)
        else teams[id] = team
      }
      if (removedTeamIds.size === 0) return state
      const teammates = Object.fromEntries(
        Object.entries(state.teammates).filter(([, tm]) => !removedTeamIds.has(tm.teamId))
      )
      const tasks = Object.fromEntries(
        Object.entries(state.tasks).filter(([, t]) => !removedTeamIds.has(t.teamId))
      )
      const activeTeamId =
        state.activeTeamId && removedTeamIds.has(state.activeTeamId) ? null : state.activeTeamId
      const editorSession = Object.fromEntries(
        Object.entries(state.editorSession).filter(([teamId]) => !removedTeamIds.has(teamId))
      )
      return { teams, teammates, tasks, activeTeamId, editorSession }
    })
  },

  setTeamStatus: (teamId, status) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state
      const updates: Partial<AgentTeam> = { status }
      if (status === "executing" && !team.startedAt) updates.startedAt = new Date()
      if (status === "completed" || status === "failed" || status === "cancelled") {
        updates.completedAt = new Date()
        if (team.startedAt) {
          updates.totalDuration = updates.completedAt.getTime() - team.startedAt.getTime()
        }
      }
      return {
        teams: { ...state.teams, [teamId]: { ...team, ...updates } },
      }
    })
  },

  // ====================================================================
  // Teammate CRUD
  // ====================================================================

  addTeammate: (input) => {
    const team = get().teams[input.teamId]
    if (!team) throw new Error(`Team not found: ${input.teamId}`)
    // ADR-0090 Phase 7: new configs bind credentials by REFERENCE only.
    assertNoNewRawTeammateCredentials(input.config)

    const teammateId = nanoid()
    const role = input.role || "teammate"
    const usedAvatarIds = new Set(
      team.teammateIds.flatMap((teammateId) => {
        const teammate = get().teammates[teammateId]
        return teammate ? [resolveAgentTeamAvatarId(teammate)] : []
      })
    )

    const teammate: AgentTeammate = {
      id: teammateId,
      teamId: input.teamId,
      name: input.name,
      description: input.description || "",
      role,
      avatarId: assignAgentTeamAvatarId(
        {
          id: teammateId,
          name: input.name,
          description: input.description,
          role,
          avatarId: input.avatarId,
        },
        usedAvatarIds
      ),
      status: "idle",
      config: input.config || {},
      spawnPrompt: input.spawnPrompt,
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    }

    set((state) => ({
      teammates: { ...state.teammates, [teammate.id]: teammate },
      teams: {
        ...state.teams,
        [input.teamId]: {
          ...team,
          teammateIds: [...team.teammateIds, teammate.id],
        },
      },
    }))

    return teammate
  },

  upsertTeammate: (teammate) => {
    // ADR-0090 Phase 7: the raw-credential rejection covers EVERY teammate
    // write path — upsert included (whole-object replace would otherwise be a
    // bypass channel). Legacy rows carrying an unchanged value stay readable.
    assertNoNewRawTeammateCredentials(teammate.config, get().teammates[teammate.id]?.config)
    set((state) => {
      const destinationTeam = state.teams[teammate.teamId]
      if (!destinationTeam) {
        agentTeamLogger.debug("upsertTeammate: team not found", {
          teamId: teammate.teamId,
          teammateId: teammate.id,
        })
        return state
      }

      const previousTeammate = state.teammates[teammate.id]
      const previousTeam = previousTeammate ? state.teams[previousTeammate.teamId] : undefined

      // Prevent a team from losing its lead reference via cross-team upsert.
      if (
        previousTeammate &&
        previousTeammate.teamId !== teammate.teamId &&
        previousTeam?.leadId === teammate.id
      ) {
        return state
      }

      let teams = state.teams
      if (previousTeammate && previousTeammate.teamId !== teammate.teamId && previousTeam) {
        teams = {
          ...teams,
          [previousTeammate.teamId]: {
            ...previousTeam,
            teammateIds: removeId(previousTeam.teammateIds, teammate.id),
          },
        }
      }

      const nextTeam = teams[teammate.teamId]
      if (nextTeam) {
        teams = {
          ...teams,
          [teammate.teamId]: {
            ...nextTeam,
            teammateIds: ensureIdExactlyOnce(nextTeam.teammateIds, teammate.id),
          },
        }
      }

      return {
        teammates: { ...state.teammates, [teammate.id]: teammate },
        teams,
      }
    })
  },

  updateTeammateCapabilities: (teammateId, overlay) => {
    set((state) => {
      const teammate = state.teammates[teammateId]
      if (!teammate) return state
      const nextConfig = { ...teammate.config }
      if (overlay === null || (overlay && Object.keys(overlay).length === 0)) {
        delete nextConfig.capabilities
      } else {
        nextConfig.capabilities = overlay
      }
      return {
        teammates: {
          ...state.teammates,
          [teammateId]: { ...teammate, config: nextConfig },
        },
      }
    })
  },

  updateTeammate: (teammateId, updates) => {
    // ADR-0090 Phase 7: reject NEW raw apiKey/baseURL values (legacy rows
    // carrying an unchanged value stay readable). Checked outside the set()
    // updater so a rejection never half-applies state.
    if (updates.config) {
      assertNoNewRawTeammateCredentials(updates.config, get().teammates[teammateId]?.config)
    }
    set((state) => {
      const teammate = state.teammates[teammateId]
      if (!teammate) return state
      return {
        teammates: { ...state.teammates, [teammateId]: { ...teammate, ...updates } },
      }
    })
  },

  removeTeammate: (teammateId) => {
    const teammate = get().teammates[teammateId]
    if (!teammate || teammate.role === "lead") return

    set((state) => {
      const { [teammateId]: _, ...restTeammates } = state.teammates
      const team = state.teams[teammate.teamId]
      if (!team) return { teammates: restTeammates }

      return {
        teammates: restTeammates,
        teams: {
          ...state.teams,
          [teammate.teamId]: {
            ...team,
            teammateIds: team.teammateIds.filter((id) => id !== teammateId),
          },
        },
      }
    })
  },

  // ====================================================================
  // Task CRUD
  // ====================================================================

  createTask: (input) => {
    const task: AgentTeamTask = normalizeAgentTeamTask({
      id: nanoid(),
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      status: "pending",
      priority: input.priority || "normal",
      assignedTo: input.assignedTo,
      dependencies: input.dependencies || [],
      tags: input.tags || [],
      expectedOutput: input.expectedOutput,
      createdAt: new Date(),
      estimatedDuration: input.estimatedDuration,
      order:
        input.order ?? Object.values(get().tasks).filter((t) => t.teamId === input.teamId).length,
      metadata: input.metadata,
    })

    set((state) => {
      const team = state.teams[input.teamId]
      return {
        tasks: { ...state.tasks, [task.id]: task },
        ...(team
          ? {
              teams: {
                ...state.teams,
                [input.teamId]: {
                  ...team,
                  taskIds: [...team.taskIds, task.id],
                },
              },
            }
          : {}),
      }
    })

    return task
  },

  upsertTask: (task) => {
    set((state) => {
      const normalizedTask = normalizeAgentTeamTask(task)
      const destinationTeam = state.teams[normalizedTask.teamId]
      if (!destinationTeam) {
        agentTeamLogger.debug("upsertTask: team not found", {
          teamId: normalizedTask.teamId,
          taskId: normalizedTask.id,
        })
        return state
      }

      const previousTask = state.tasks[normalizedTask.id]
      const previousTeam = previousTask ? state.teams[previousTask.teamId] : undefined

      let teams = state.teams
      if (previousTask && previousTask.teamId !== normalizedTask.teamId && previousTeam) {
        teams = {
          ...teams,
          [previousTask.teamId]: {
            ...previousTeam,
            taskIds: removeId(previousTeam.taskIds, normalizedTask.id),
          },
        }
      }

      const nextTeam = teams[normalizedTask.teamId]
      if (nextTeam) {
        teams = {
          ...teams,
          [normalizedTask.teamId]: {
            ...nextTeam,
            taskIds: ensureIdExactlyOnce(nextTeam.taskIds, normalizedTask.id),
          },
        }
      }

      return {
        tasks: { ...state.tasks, [normalizedTask.id]: normalizedTask },
        teams,
      }
    })
  },

  updateTask: (taskId, updates) => {
    set((state) => {
      const task = state.tasks[taskId]
      if (!task) return state
      return {
        tasks: { ...state.tasks, [taskId]: { ...task, ...updates } },
      }
    })
  },

  deleteTask: (taskId) => {
    const task = get().tasks[taskId]
    if (!task) return

    set((state) => {
      const { [taskId]: _, ...restTasks } = state.tasks
      const team = state.teams[task.teamId]
      if (!team) return { tasks: restTasks }

      return {
        tasks: restTasks,
        teams: {
          ...state.teams,
          [task.teamId]: {
            ...team,
            taskIds: team.taskIds.filter((id) => id !== taskId),
          },
        },
      }
    })
  },

  setTaskStatus: (taskId, status, result, error) => {
    set((state) => {
      const task = state.tasks[taskId]
      if (!task) return state

      const updates: Partial<AgentTeamTask> = { status }
      if (result !== undefined) updates.result = result
      if (error !== undefined) updates.error = error
      if (status === "in_progress" && !task.startedAt) updates.startedAt = new Date()
      if (status === "completed" || status === "failed" || status === "cancelled") {
        updates.completedAt = new Date()
        if (task.startedAt) {
          updates.actualDuration = updates.completedAt.getTime() - task.startedAt.getTime()
        }
      }

      return {
        tasks: { ...state.tasks, [taskId]: { ...task, ...updates } },
      }
    })
  },

  moveTask: (taskId, to) => {
    const task = get().tasks[taskId]
    if (!task) return { ok: false, reason: "task-not-found" }
    const team = get().teams[task.teamId]
    const verdict = canMoveTask(task, task.status, to, team?.status ?? "idle")
    if (!verdict.allowed) return { ok: false, reason: verdict.reason }
    if (task.status === to) return { ok: true }

    set((state) => {
      const current = state.tasks[taskId]
      if (!current) return state

      const updates: Partial<AgentTeamTask> = { status: to }
      if (to === "pending") {
        // Un-strand / manual retry: clear the run-owned fields so the next
        // run (or resume) re-dispatches the task from a clean slate.
        updates.claimedBy = undefined
        updates.startedAt = undefined
        updates.completedAt = undefined
        updates.actualDuration = undefined
        updates.error = undefined
      } else if (to === "completed" || to === "failed" || to === "cancelled") {
        updates.completedAt = new Date()
        if (current.startedAt) {
          updates.actualDuration = updates.completedAt.getTime() - current.startedAt.getTime()
        }
      }

      // Release the claim mirror when the task leaves a claimed state.
      const claimedBy = current.claimedBy
      const teammate = claimedBy ? state.teammates[claimedBy] : undefined
      const releaseTeammate = to === "pending" && teammate?.currentTaskId === taskId

      return {
        tasks: { ...state.tasks, [taskId]: { ...current, ...updates } },
        ...(releaseTeammate && claimedBy
          ? {
              teammates: {
                ...state.teammates,
                [claimedBy]: { ...teammate, currentTaskId: undefined },
              },
            }
          : {}),
      }
    })
    return { ok: true }
  },

  reorderTask: (taskId, targetIndex) => {
    const task = get().tasks[taskId]
    if (!task) return

    set((state) => {
      const current = state.tasks[taskId]
      if (!current) return state
      const column = sortColumn(
        Object.values(state.tasks).filter(
          (t) => t.teamId === current.teamId && t.status === current.status
        )
      )
      const changes = reorderColumn(column, taskId, targetIndex)
      if (changes.length === 0) return state

      const tasks = { ...state.tasks }
      for (const { id, order } of changes) {
        const row = tasks[id]
        if (row) tasks[id] = { ...row, order }
      }
      return { tasks }
    })
  },

  assignTask: (taskId, teammateId) => {
    set((state) => {
      const task = state.tasks[taskId]
      if (!task) return state
      return {
        tasks: {
          ...state.tasks,
          [taskId]: { ...task, assignedTo: teammateId },
        },
      }
    })
  },

  addTaskComment: (input) => {
    const task = get().tasks[input.taskId]
    if (!task) return null
    const text = typeof input.text === "string" ? input.text.trim() : ""
    if (!text) return null
    const author = get().teammates[input.authorId]
    const authorName =
      input.authorName ||
      (input.authorId === "user"
        ? "You"
        : author?.name || (input.authorId === "system" ? "System" : "Unknown"))
    const comment: AgentTaskComment = {
      id: nanoid(),
      taskId: input.taskId,
      authorId: input.authorId,
      authorName,
      text,
      createdAt: new Date(),
      ...(input.attachments && input.attachments.length > 0
        ? { attachments: input.attachments.map((a) => ({ ...a, id: nanoid() })) }
        : {}),
    }
    set((state) => {
      const current = state.tasks[input.taskId]
      if (!current) return state
      return {
        tasks: {
          ...state.tasks,
          [input.taskId]: { ...current, comments: [...(current.comments ?? []), comment] },
        },
      }
    })
    return comment
  },

  attachTaskFile: (taskId, attachment) => {
    set((state) => {
      const task = state.tasks[taskId]
      if (!task) return state
      const next: TaskCommentAttachment = { ...attachment, id: nanoid() }
      return {
        tasks: {
          ...state.tasks,
          [taskId]: { ...task, attachments: [...(task.attachments ?? []), next] },
        },
      }
    })
  },

  // ====================================================================
  // Messages
  // ====================================================================

  addMessage: (input) => {
    const sender = get().teammates[input.senderId]
    const recipient = input.recipientId ? get().teammates[input.recipientId] : undefined

    const message: AgentTeamMessage = {
      id: nanoid(),
      teamId: input.teamId,
      type: input.type || (input.recipientId ? "direct" : "broadcast"),
      senderId: input.senderId,
      senderName: sender?.name || "Unknown",
      recipientId: input.recipientId,
      recipientName: recipient?.name,
      content: input.content,
      taskId: input.taskId,
      read: false,
      timestamp: new Date(),
      metadata: input.metadata,
      structuredPayload: input.structuredPayload,
    }

    set((state) => {
      const team = state.teams[input.teamId]
      return {
        messages: { ...state.messages, [message.id]: message },
        ...(team
          ? {
              teams: {
                ...state.teams,
                [input.teamId]: {
                  ...team,
                  messageIds: [...team.messageIds, message.id],
                },
              },
            }
          : {}),
      }
    })

    return message
  },

  removeMessage: (messageId) => {
    set((state) => {
      const msg = state.messages[messageId]
      if (!msg) return state
      const team = state.teams[msg.teamId]
      const nextMessages = { ...state.messages }
      delete nextMessages[messageId]
      const nextTeams = team
        ? {
            ...state.teams,
            [msg.teamId]: {
              ...team,
              messageIds: removeId(team.messageIds, messageId),
            },
          }
        : state.teams
      return { messages: nextMessages, teams: nextTeams }
    })
  },

  // ====================================================================
  // Events
  // ====================================================================

  addEvent: (event) => {
    set((state) => {
      // Live teammate-progress events update a single row in place: a
      // `progress_update` for a given task replaces the existing non-terminal
      // progress row for that same task instead of appending one row per
      // streamed frame. Terminal frames (phase done/failed) replace the live
      // row and then freeze (later frames append, though none are expected).
      if (event.type === "progress_update" && event.taskId) {
        const idx = state.events.findIndex(
          (e) =>
            e.type === "progress_update" &&
            e.taskId === event.taskId &&
            e.data?.phase !== "done" &&
            e.data?.phase !== "failed"
        )
        if (idx !== -1) {
          const next = state.events.slice()
          next[idx] = event
          return { events: next }
        }
      }
      return {
        events: [...state.events.slice(-99), event], // Keep last 100
      }
    })
  },

  clearEvents: (teamId) => {
    if (teamId) {
      set((state) => ({
        events: state.events.filter((e) => e.teamId !== teamId),
      }))
    } else {
      set({ events: [] })
    }
  },

  // ====================================================================
  // Templates
  // ====================================================================

  addTemplate: (template) => {
    set((state) => ({
      templates: { ...state.templates, [template.id]: template },
    }))
  },

  deleteTemplate: (templateId) => {
    set((state) => {
      const template = state.templates[templateId]
      if (!template || template.isBuiltIn) return state
      const { [templateId]: _, ...rest } = state.templates
      return { templates: rest }
    })
  },

  saveAsTemplate: (teamId, name, category) => {
    const state = get()
    const team = state.teams[teamId]
    if (!team) return null

    const teammates = team.teammateIds
      .map((id) => state.teammates[id])
      .filter((tm): tm is AgentTeammate => tm !== undefined && tm.role !== "lead")

    const template: AgentTeamTemplate = {
      id: nanoid(),
      name,
      description: team.description || `Template created from team "${team.name}"`,
      category: category || "general",
      teammates: teammates.map((tm) => ({
        name: tm.name,
        description: tm.description,
        specialization: tm.config.specialization,
        config: {
          provider: tm.config.provider,
          model: tm.config.model,
          temperature: tm.config.temperature,
          maxSteps: tm.config.maxSteps,
          specialization: tm.config.specialization,
        },
      })),
      config: {
        executionMode: team.config.executionMode,
        preferredExecutionPattern: team.config.preferredExecutionPattern,
        maxConcurrentTeammates: team.config.maxConcurrentTeammates,
        requirePlanApproval: team.config.requirePlanApproval,
        enableMessaging: team.config.enableMessaging,
        maxRetries: team.config.maxRetries,
        maxPlanRevisions: team.config.maxPlanRevisions,
        enableTaskRetry: team.config.enableTaskRetry,
        tokenBudget: team.config.tokenBudget,
        governancePolicy: team.config.governancePolicy,
      },
      isBuiltIn: false,
    }

    set((s) => ({
      templates: { ...s.templates, [template.id]: template },
    }))

    return template
  },

  updateTemplate: (templateId, updates) => {
    set((state) => {
      const template = state.templates[templateId]
      if (!template || template.isBuiltIn) return state
      return {
        templates: {
          ...state.templates,
          [templateId]: { ...template, ...updates, id: templateId, isBuiltIn: false },
        },
      }
    })
  },

  // ====================================================================
  // UI State
  // ====================================================================

  setTasksView: (view) => set({ tasksView: view }),
  // ====================================================================
  // Selectors
  // ====================================================================

  getTeam: (teamId) => get().teams[teamId],
  getTeammate: (teammateId) => get().teammates[teammateId],

  getTeammates: (teamId) => {
    const team = get().teams[teamId]
    if (!team) return []
    return team.teammateIds
      .map((id) => get().teammates[id])
      .filter((tm): tm is AgentTeammate => tm !== undefined)
  },

  getTeamTasks: (teamId) => {
    const team = get().teams[teamId]
    if (!team) return []
    return team.taskIds
      .map((id) => get().tasks[id])
      .filter((t): t is AgentTeamTask => t !== undefined)
      .sort((a, b) => a.order - b.order)
  },

  getTaskComments: (taskId) => {
    return get().tasks[taskId]?.comments ?? []
  },

  getTeamMessages: (teamId) => {
    const team = get().teams[teamId]
    if (!team) return []
    return team.messageIds
      .map((id) => get().messages[id])
      .filter((m): m is AgentTeamMessage => m !== undefined)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  },

  getActiveTeam: () => {
    const { activeTeamId, teams } = get()
    return activeTeamId ? teams[activeTeamId] : undefined
  },

  // ====================================================================
  // Consensus
  // ====================================================================

  upsertConsensus: (consensus) => {
    set((state) => {
      const team = state.teams[consensus.teamId]
      const teams = team
        ? {
            ...state.teams,
            [consensus.teamId]: {
              ...team,
              consensusIds: ensureIdExactlyOnce(team.consensusIds || [], consensus.id),
            },
          }
        : state.teams
      return {
        consensus: { ...state.consensus, [consensus.id]: consensus },
        teams,
      }
    })
  },

  deleteConsensus: (consensusId) => {
    set((state) => {
      const consensus = state.consensus[consensusId]
      if (!consensus) return state
      const { [consensusId]: _, ...rest } = state.consensus
      const team = state.teams[consensus.teamId]
      return {
        consensus: rest,
        ...(team
          ? {
              teams: {
                ...state.teams,
                [consensus.teamId]: {
                  ...team,
                  consensusIds: (team.consensusIds || []).filter((id) => id !== consensusId),
                },
              },
            }
          : {}),
      }
    })
  },

  clearTeamConsensus: (teamId) => {
    set((state) => {
      const updated = { ...state.consensus }
      for (const [id, c] of Object.entries(updated)) {
        if (c.teamId === teamId) delete updated[id]
      }
      const team = state.teams[teamId]
      return {
        consensus: updated,
        ...(team
          ? {
              teams: {
                ...state.teams,
                [teamId]: { ...team, consensusIds: [] },
              },
            }
          : {}),
      }
    })
  },

  // ====================================================================
  // Shared Memory
  // ====================================================================

  writeSharedMemory: (teamId, key, entry) => {
    set((state) => {
      const team = state.teams[teamId]
      const teamMemory = state.sharedMemory[teamId] || {}

      // Enforce max entries if configured
      const config = team?.config
      const maxEntries = config?.maxSharedMemoryEntries
      if (maxEntries && Object.keys(teamMemory).length >= maxEntries && !teamMemory[key]) {
        // Evict oldest entry
        const oldest = Object.entries(teamMemory).sort(
          ([, a], [, b]) => new Date(a.writtenAt).getTime() - new Date(b.writtenAt).getTime()
        )[0]
        if (oldest) {
          delete teamMemory[oldest[0]]
        }
      }

      const updatedTeamMemory = { ...teamMemory, [key]: entry }
      return {
        sharedMemory: { ...state.sharedMemory, [teamId]: updatedTeamMemory },
        ...(team
          ? {
              teams: {
                ...state.teams,
                [teamId]: {
                  ...team,
                  sharedMemory: { ...team.sharedMemory, [key]: entry },
                },
              },
            }
          : {}),
      }
    })
  },

  deleteSharedMemory: (teamId, key) => {
    set((state) => {
      const teamMemory = state.sharedMemory[teamId]
      if (!teamMemory || !teamMemory[key]) return state
      const { [key]: _, ...rest } = teamMemory
      const team = state.teams[teamId]
      const teamSharedMem = team?.sharedMemory ? { ...team.sharedMemory } : undefined
      if (teamSharedMem) delete teamSharedMem[key]
      return {
        sharedMemory: { ...state.sharedMemory, [teamId]: rest },
        ...(team && teamSharedMem !== undefined
          ? {
              teams: {
                ...state.teams,
                [teamId]: { ...team, sharedMemory: teamSharedMem },
              },
            }
          : {}),
      }
    })
  },

  clearTeamSharedMemory: (teamId) => {
    set((state) => {
      const { [teamId]: _, ...rest } = state.sharedMemory
      const team = state.teams[teamId]
      return {
        sharedMemory: rest,
        ...(team
          ? {
              teams: {
                ...state.teams,
                [teamId]: { ...team, sharedMemory: {} },
              },
            }
          : {}),
      }
    })
  },

  setAdapterSyncVersion: (teamId, adapterId, version) => {
    set((state) => ({
      lastAdapterSyncVersion: {
        ...state.lastAdapterSyncVersion,
        [teamId]: { ...(state.lastAdapterSyncVersion[teamId] ?? {}), [adapterId]: version },
      },
    }))
  },

  // ====================================================================
  // Delegations
  // ====================================================================

  upsertDelegation: (delegation) => {
    set((state) => ({
      delegations: { ...state.delegations, [delegation.id]: delegation },
    }))
  },

  updateDelegationStatus: (delegationId, status, result) => {
    set((state) => {
      const delegation = state.delegations[delegationId]
      if (!delegation) return state
      const updates: Partial<TeamDelegationRecord> = {
        status,
        updatedAt: new Date(),
      }
      if (result !== undefined) updates.result = result
      if (status === "completed" || status === "failed" || status === "cancelled") {
        updates.completedAt = new Date()
      }
      return {
        delegations: {
          ...state.delegations,
          [delegationId]: { ...delegation, ...updates },
        },
      }
    })
  },

  clearTeamDelegations: (teamId) => {
    set((state) => {
      const updated = { ...state.delegations }
      for (const [id, d] of Object.entries(updated)) {
        if (d.sourceTeamId === teamId) delete updated[id]
      }
      return { delegations: updated }
    })
  },

  // ====================================================================
  // Execution Reports
  // ====================================================================

  upsertExecutionReport: (teamId, report) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state
      return {
        teams: {
          ...state.teams,
          [teamId]: { ...team, executionReport: report },
        },
      }
    })
  },

  addExecutionCheckpoint: (teamId, checkpoint) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state
      const report = team.executionReport
      if (!report) return state
      return {
        teams: {
          ...state.teams,
          [teamId]: {
            ...team,
            executionReport: {
              ...report,
              checkpoints: [...report.checkpoints, checkpoint],
            },
          },
        },
      }
    })
  },

  // ====================================================================
  // Reset
  // ====================================================================

  reset: () => {
    set({ ...initialState, templates: builtInTemplatesMap })
  },
})
