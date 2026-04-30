import type { StoreApi } from "zustand"
import { nanoid } from "nanoid"
import {
  type AgentTeam,
  type AgentTeammate,
  type AgentTeamTask,
  type AgentTeamMessage,
  type AgentTeamConfig,
  type AgentTeamTemplate,
  type TeamDelegationRecord,
} from "@/types/agent/agent-team"
import { normalizeAgentTeamConfig, normalizeAgentTeamTask } from "@/lib/ai/agent/agent-team-compat"
import { loggers } from "@/lib/logger"
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
      status: "idle",
      config: {},
      completedTaskIds: [],
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      progress: 0,
      createdAt: new Date(),
    }

    const team: AgentTeam = {
      id: teamId,
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

  upsertTeam: (team) => {
    set((state) => ({
      teams: { ...state.teams, [team.id]: team },
    }))
  },

  updateTeam: (teamId, updates) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state
      return {
        teams: { ...state.teams, [teamId]: { ...team, ...updates } },
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
      get().shutdownAllTeammates(teamId)
    }
    get().cleanupTeam(teamId)
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

    const teammate: AgentTeammate = {
      id: nanoid(),
      teamId: input.teamId,
      name: input.name,
      description: input.description || "",
      role: input.role || "teammate",
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

  updateTeammate: (teammateId, updates) => {
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

  setTeammateStatus: (teammateId, status) => {
    set((state) => {
      const teammate = state.teammates[teammateId]
      if (!teammate) return state
      return {
        teammates: {
          ...state.teammates,
          [teammateId]: { ...teammate, status, lastActiveAt: new Date() },
        },
      }
    })
  },

  setTeammateProgress: (teammateId, progress) => {
    set((state) => {
      const teammate = state.teammates[teammateId]
      if (!teammate) return state
      return {
        teammates: {
          ...state.teammates,
          [teammateId]: { ...teammate, progress: Math.min(100, Math.max(0, progress)) },
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

  claimTask: (taskId, teammateId) => {
    set((state) => {
      const task = state.tasks[taskId]
      if (!task || task.status !== "pending") return state
      // Busy-check: reject if teammate is already executing a task (OCC pattern)
      const teammate = state.teammates[teammateId]
      if (teammate?.status === "executing" && teammate.currentTaskId) return state
      return {
        tasks: {
          ...state.tasks,
          [taskId]: { ...task, claimedBy: teammateId, status: "claimed" },
        },
        teammates: teammate
          ? {
              ...state.teammates,
              [teammateId]: { ...teammate, currentTaskId: taskId },
            }
          : state.teammates,
      }
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

  upsertMessage: (message) => {
    set((state) => {
      const destinationTeam = state.teams[message.teamId]
      if (!destinationTeam) {
        agentTeamLogger.debug("upsertMessage: team not found", {
          teamId: message.teamId,
          messageId: message.id,
        })
        return state
      }

      const previousMessage = state.messages[message.id]
      const previousTeam = previousMessage ? state.teams[previousMessage.teamId] : undefined

      let teams = state.teams
      if (previousMessage && previousMessage.teamId !== message.teamId && previousTeam) {
        teams = {
          ...teams,
          [previousMessage.teamId]: {
            ...previousTeam,
            messageIds: removeId(previousTeam.messageIds, message.id),
          },
        }
      }

      const nextTeam = teams[message.teamId]
      if (nextTeam) {
        teams = {
          ...teams,
          [message.teamId]: {
            ...nextTeam,
            messageIds: ensureIdExactlyOnce(nextTeam.messageIds, message.id),
          },
        }
      }

      return {
        messages: { ...state.messages, [message.id]: message },
        teams,
      }
    })
  },

  markMessageRead: (messageId) => {
    set((state) => {
      const msg = state.messages[messageId]
      if (!msg) return state
      return {
        messages: { ...state.messages, [messageId]: { ...msg, read: true } },
      }
    })
  },

  markAllMessagesRead: (teammateId) => {
    set((state) => {
      const updated = { ...state.messages }
      for (const [id, msg] of Object.entries(updated)) {
        if (
          !msg.read &&
          (msg.recipientId === teammateId ||
            (msg.type === "broadcast" && msg.senderId !== teammateId))
        ) {
          updated[id] = { ...msg, read: true }
        }
      }
      return { messages: updated }
    })
  },

  markTeamMessagesRead: (teamId) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team || team.messageIds.length === 0) return state
      let mutated = false
      const updated = { ...state.messages }
      for (const id of team.messageIds) {
        const msg = updated[id]
        if (msg && !msg.read) {
          updated[id] = { ...msg, read: true }
          mutated = true
        }
      }
      if (!mutated) return state
      return { messages: updated }
    })
  },

  // ====================================================================
  // Events
  // ====================================================================

  addEvent: (event) => {
    set((state) => ({
      events: [...state.events.slice(-99), event], // Keep last 100
    }))
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

  importTemplates: (templates) => {
    let imported = 0
    set((state) => {
      const updated = { ...state.templates }
      for (const template of templates) {
        const id = template.id || nanoid()
        if (!updated[id] || !updated[id].isBuiltIn) {
          updated[id] = { ...template, id, isBuiltIn: false }
          imported++
        }
      }
      return { templates: updated }
    })
    return imported
  },

  exportTemplates: () => {
    const state = get()
    return Object.values(state.templates).filter((t) => !t.isBuiltIn)
  },

  // ====================================================================
  // UI State
  // ====================================================================

  setActiveTeam: (teamId) =>
    set((state) => {
      if (!teamId) {
        return {
          activeTeamId: null,
          selectedTeammateId: null,
          workspaceFocus: {
            ...state.workspaceFocus,
            teammateId: null,
          },
        }
      }

      const team = state.teams[teamId]
      if (!team) return state

      const selectedTeammateId =
        state.selectedTeammateId && team.teammateIds.includes(state.selectedTeammateId)
          ? state.selectedTeammateId
          : null

      return {
        activeTeamId: teamId,
        selectedTeammateId,
        workspaceFocus: {
          ...state.workspaceFocus,
          teammateId: selectedTeammateId,
        },
      }
    }),
  setSelectedTeammate: (teammateId) =>
    set((state) => ({
      selectedTeammateId: teammateId,
      workspaceFocus: {
        ...state.workspaceFocus,
        teammateId,
      },
      workspaceDetailOpen: teammateId ? true : state.workspaceDetailOpen,
    })),
  setDisplayMode: (mode) => set({ displayMode: mode }),
  setIsPanelOpen: (open) => set({ isPanelOpen: open }),
  setWorkspaceTab: (tab) => set({ workspaceTab: tab }),
  setWorkspaceFocus: (focus) =>
    set((state) => ({
      workspaceFocus: {
        ...state.workspaceFocus,
        teammateId:
          focus.teammateId === undefined ? state.workspaceFocus.teammateId : focus.teammateId,
        taskId: focus.taskId === undefined ? state.workspaceFocus.taskId : focus.taskId,
        messageId: focus.messageId === undefined ? state.workspaceFocus.messageId : focus.messageId,
      },
      selectedTeammateId:
        focus.teammateId === undefined ? state.selectedTeammateId : focus.teammateId,
      workspaceDetailOpen: true,
    })),
  setWorkspaceTeamFromRoute: (teamId) =>
    set((state) => {
      if (!teamId || !state.teams[teamId]) return state

      const team = state.teams[teamId]
      const nextSelectedTeammateId =
        state.selectedTeammateId && team.teammateIds.includes(state.selectedTeammateId)
          ? state.selectedTeammateId
          : null

      return {
        activeTeamId: teamId,
        selectedTeammateId: nextSelectedTeammateId,
        workspaceFocus: {
          ...state.workspaceFocus,
          teammateId: nextSelectedTeammateId,
        },
      }
    }),
  closeAgentTeamWorkspaceDetail: () =>
    set(() => ({
      workspaceDetailOpen: false,
      selectedTeammateId: null,
      workspaceFocus: {
        teammateId: null,
        taskId: null,
        messageId: null,
      },
    })),

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

  getTeamMessages: (teamId) => {
    const team = get().teams[teamId]
    if (!team) return []
    return team.messageIds
      .map((id) => get().messages[id])
      .filter((m): m is AgentTeamMessage => m !== undefined)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  },

  getUnreadMessages: (teammateId) => {
    return Object.values(get().messages).filter((msg) => {
      if (msg.read) return false
      if (msg.recipientId === teammateId) return true
      if (msg.type === "broadcast" && msg.senderId !== teammateId) return true
      return false
    })
  },

  getActiveTeam: () => {
    const { activeTeamId, teams } = get()
    return activeTeamId ? teams[activeTeamId] : undefined
  },

  // ====================================================================
  // Batch Operations
  // ====================================================================

  cancelAllTasks: (teamId) => {
    set((state) => {
      const team = state.teams[teamId]
      if (!team) return state

      const updatedTasks = { ...state.tasks }
      for (const taskId of team.taskIds) {
        const task = updatedTasks[taskId]
        if (
          task &&
          (task.status === "pending" ||
            task.status === "in_progress" ||
            task.status === "claimed" ||
            task.status === "blocked")
        ) {
          updatedTasks[taskId] = { ...task, status: "cancelled", completedAt: new Date() }
        }
      }
      return { tasks: updatedTasks }
    })
  },

  shutdownAllTeammates: (teamId) => {
    set((state) => {
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
    })
  },

  cleanupTeam: (teamId) => {
    set((state) => {
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

      return {
        teams: restTeams,
        teammates: restTeammates,
        tasks: restTasks,
        messages: restMessages,
        consensus: restConsensus,
        sharedMemory: restSharedMemory,
        delegations: restDelegations,
        activeTeamId: state.activeTeamId === teamId ? null : state.activeTeamId,
      }
    })
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
  // Structured Messages
  // ====================================================================

  addStructuredMessage: (input) => {
    const sender = get().teammates[input.senderId]
    const recipient = input.recipientId ? get().teammates[input.recipientId] : undefined

    // Derive message type from structured payload
    const payloadTypeMap: Record<string, string> = {
      shutdown_request: "shutdown",
      shutdown_response: "shutdown",
      plan_approval_request: "plan_approval",
      plan_approval_response: "plan_approval",
      idle_notification: "idle",
      task_assignment: "task_assignment",
      consensus_request: "consensus",
      consensus_vote: "consensus",
    }
    const derivedType = payloadTypeMap[input.structuredPayload.type] || input.type || "system"

    const message: AgentTeamMessage = {
      id: nanoid(),
      teamId: input.teamId,
      type: derivedType as AgentTeamMessage["type"],
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

  // ====================================================================
  // Lifecycle
  // ====================================================================

  requestTeammateShutdown: (teammateId, reason) => {
    const teammate = get().teammates[teammateId]
    if (!teammate) return
    // Set status to shutdown
    set((state) => ({
      teammates: {
        ...state.teammates,
        [teammateId]: {
          ...state.teammates[teammateId],
          status: "shutdown" as const,
          currentTaskId: undefined,
        },
      },
    }))
    // Send structured shutdown message via the team lead
    const team = get().teams[teammate.teamId]
    if (team) {
      get().addStructuredMessage({
        teamId: teammate.teamId,
        senderId: team.leadId,
        recipientId: teammateId,
        content: reason || `Shutdown requested for ${teammate.name}`,
        structuredPayload: { type: "shutdown_request", reason },
      })
    }
  },

  // ====================================================================
  // Settings
  // ====================================================================

  updateDefaultConfig: (config) => {
    const currentDefaultConfig = get().defaultConfig
    const executionModeChanged =
      config.executionMode !== undefined &&
      config.executionMode !== currentDefaultConfig.executionMode
    const legacyGovernanceChanged =
      config.requirePlanApproval !== undefined || config.tokenBudget !== undefined

    set((state) => ({
      defaultConfig: normalizeAgentTeamConfig({
        ...state.defaultConfig,
        ...config,
        preferredExecutionPattern:
          executionModeChanged &&
          config.preferredExecutionPattern === currentDefaultConfig.preferredExecutionPattern
            ? undefined
            : (config.preferredExecutionPattern ?? state.defaultConfig.preferredExecutionPattern),
        governancePolicy:
          legacyGovernanceChanged &&
          config.governancePolicy === currentDefaultConfig.governancePolicy
            ? undefined
            : (config.governancePolicy ?? state.defaultConfig.governancePolicy),
      }),
    }))
  },

  // ====================================================================
  // Reset
  // ====================================================================

  reset: () => {
    set({ ...initialState, templates: builtInTemplatesMap })
  },
})
