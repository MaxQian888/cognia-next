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
 *  - Lifecycle (create / delete / duplicate / save-as-template) is `team:write`
 *    too. It was the half of the surface that did not exist: a plugin could
 *    add teammates, feed the board and run the thing, but the only way to
 *    obtain a Squad at all was `instantiateTemplate`, and the only way to lose
 *    one was for a human to click Delete. `createTeam` goes through
 *    `createSquad`, not the store action, so a plugin-made Squad lands on
 *    the workspace's repository and environment bindings (ADR-0169).
 */

import { loggers } from "@cognia/logging"

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { toPublicBestOfNRun } from "@/lib/best-of-n/public-run"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type {
  PluginTeamAPI,
  PluginTeamRunControlResult,
  PluginTeamTaskPatch,
  PluginTeamTeammatePatch,
} from "@cognia/plugin-contract/lib/plugin/api/team-api"
export type {
  PluginBestOfNStartInput,
  PluginBestOfNStartResult,
  PluginTeamAPI,
  PluginTeamCreateInput,
  PluginTeamDuplicateInput,
  PluginTeamMoveResult,
  PluginTeamRunControlResult,
  PluginTeamRunStatus,
  PluginTeamTaskCreateInput,
  PluginTeamTaskPatch,
  PluginTeamTeammateCreateInput,
  PluginTeamTeammatePatch,
} from "@cognia/plugin-contract/lib/plugin/api/team-api"

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
    const { agentTeamManager } = await import("@/lib/ai/agent/team/agent-team")
    await agentTeamManager[verb](teamId)
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "dispatch_error" }
  }
}

/**
 * The prompt `ctx.templates.createDraft` raises, raised from here too.
 *
 * Same broker, same permission id, same `library-write:` reason prefix, so a
 * user who has answered "always allow" for this plugin's template writes is
 * not asked twice for what is the same decision.
 */
async function confirmTemplateLibraryWrite(pluginId: string, definitionId: string): Promise<void> {
  const { getPluginConsentBroker } = await import("@/lib/plugin/security/consent-broker")
  const confirmed = await getPluginConsentBroker().request({
    pluginId,
    permission: "templates:library:write",
    reason: `library-write:${definitionId}`,
  })
  if (!confirmed) {
    throw new Error("Plugin template library write was denied by user confirmation")
  }
}

/**
 * Record which plugin created the mirrored draft, the way
 * `lib/plugin/api/templates-api.ts` does for every other library write.
 *
 * Without it the mirror is an unattributable row, so the ownership refusals on
 * `ctx.templates.saveDraft` / `publish` / `deleteDraft` cannot tell a
 * plugin-created squad template from one the user wrote, and a plugin can
 * neither manage its own mirror nor be stopped from managing someone else's.
 *
 * A foreign stamp is refused rather than overwritten: two plugins saving a
 * squad template under the same legacy id is a collision, not a handover.
 * Non-fatal on every other path, exactly like the mirror it follows.
 */
async function stampMirroredTemplateAuthorship(
  pluginId: string,
  definitionId: string
): Promise<void> {
  try {
    const { getTemplateRuntime } = await import("@/lib/templates/runtime")
    const runtime = getTemplateRuntime()
    const draft = await runtime.repository.getDraft(definitionId)
    if (!draft) return
    if (draft.provenance.pluginId === pluginId) return
    if (draft.provenance.pluginId) {
      throw new Error(
        `Template ${definitionId} already belongs to plugin "${draft.provenance.pluginId}"`
      )
    }
    await runtime.service.saveDraft(
      { ...draft, provenance: { ...draft.provenance, pluginId } },
      draft.revision
    )
  } catch (error) {
    loggers.agent.warn("squad template plugin attribution failed", {
      definitionId,
      err: String(error),
    })
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

    // lifecycle
    createTeam: async (input) => {
      const [{ createSquad }, { useProjectStore }] = await Promise.all([
        import("@/lib/agent-team/create-squad"),
        import("@/stores/project/project-store"),
      ])
      const projectState = useProjectStore.getState()
      const project = projectState.projects.find((p) => p.id === projectState.activeProjectId)
      return createSquad(
        {
          name: input.name,
          task: input.task,
          ...(input.description ? { description: input.description } : {}),
          ...(input.leadName ? { leadName: input.leadName } : {}),
          ...(input.leadDescription ? { leadDescription: input.leadDescription } : {}),
          ...(input.config ? { config: input.config } : {}),
        },
        { createTeam: useAgentTeamStore.getState().createTeam, project }
      )
    },
    deleteTeam: async (teamId) => {
      if (!useAgentTeamStore.getState().teams[teamId]) return false
      await useAgentTeamStore.getState().deleteTeam(teamId)
      return true
    },
    duplicateTeam: async (teamId, input) =>
      useAgentTeamStore.getState().duplicateSquad(teamId, {
        name: input.name,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      }),
    saveAsTemplate: async (teamId, name, category) => {
      // This call reaches `TemplateService.saveDraft`, the same write
      // `ctx.templates.createDraft` performs, so it answers to the same two
      // gates. It used to answer to neither: `team:write` alone put a row in
      // the user's template library with no consent prompt and no attribution,
      // which made it the way around every check on `ctx.templates`.
      //
      // Consent is asked BEFORE the legacy store write, so a refusal leaves
      // nothing behind, and it throws rather than returning null because a
      // null here already means "no such squad".
      await confirmTemplateLibraryWrite(pluginId, name)
      const template = useAgentTeamStore.getState().saveAsTemplate(teamId, name, category)
      if (!template) return null
      // Same write-time mirror the Settings derive action performs, so a
      // plugin-saved template shows up in the unified catalog immediately
      // instead of only after the next boot projection. Non-fatal: the legacy
      // store is still the read side.
      const { platformIdForSquadTemplate, publishSquadTemplateToPlatform } =
        await import("@/lib/agent-team/publish-template-to-platform")
      await publishSquadTemplateToPlatform(template).catch(() => undefined)
      await stampMirroredTemplateAuthorship(pluginId, platformIdForSquadTemplate(template))
      return template
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
      const { startSquadRun } = await import("@/lib/ai/agent/team/squad/start-squad-run")
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

    // best-of-N: start and observe only
    startBestOfN: async (input) => {
      const { canManageBestOfNRuns } = await import("@/lib/best-of-n/projection")
      if (!canManageBestOfNRuns()) return { ok: false, reason: "host_unavailable" }
      const n = input.n ?? input.agents?.length ?? 2
      if (n !== 2 && n !== 3 && n !== 4) return { ok: false, reason: "invalid_count" }
      try {
        const { prepareBestOfNChat, startPreparedBestOfN } = await import("@/lib/best-of-n/entry")
        const prepared = await prepareBestOfNChat(input.sessionId, input.prompt, n, input.agents)
        const group = await startPreparedBestOfN(
          prepared,
          { targetRef: prepared.targetRef, targetIsNew: true },
          prepared.agents,
          { automatedTurn: "plugin" }
        )
        return { ok: true, run: toPublicBestOfNRun(group) }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "dispatch_error" }
      }
    },
    getBestOfN: async (groupId) => {
      const { getBestOfNRun } = await import("@/lib/best-of-n/projection")
      const run = await getBestOfNRun(groupId)
      return run ? toPublicBestOfNRun(run.group) : null
    },
    listBestOfN: async () => {
      const { getDb } = await import("@/lib/db/schema")
      const runs = await getDb().bestOfNRuns.toArray()
      return runs
        .map((run) => toPublicBestOfNRun(run.group))
        .sort((a, b) => b.createdAt - a.createdAt)
    },
    cancelBestOfN: async (groupId) => {
      const { canManageBestOfNRuns } = await import("@/lib/best-of-n/projection")
      if (!canManageBestOfNRuns()) return { ok: false, reason: "host_unavailable" }
      try {
        const { cancelBestOfN } = await import("@/lib/best-of-n/service")
        await cancelBestOfN(groupId)
        return { ok: true }
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "dispatch_error" }
      }
    },
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
    // Lifecycle is a board-level write, not dispatch: none of these four
    // spends a token. `start` below is where that line is.
    createTeam: "team:write",
    deleteTeam: "team:write",
    duplicateTeam: "team:write",
    // Two permissions, because this is two writes: a squad template in the
    // legacy store AND a draft in the user's unified template library. The
    // second one is what `ctx.templates` calls `templates:library:write`, and
    // naming only `team:write` here is what made this the back door.
    saveAsTemplate: ["team:write", "templates:library:write"],
    // Starting spends tokens the way `ctx.agent.runTeam` does, and takes the
    // same permission. Pause / resume / stop are execution control, which
    // `agent:control` already names.
    start: "agent:dispatch",
    pause: "agent:control",
    resume: "agent:control",
    stop: "agent:control",
    startBestOfN: "agent:dispatch",
    getBestOfN: "team:read",
    listBestOfN: "team:read",
    cancelBestOfN: "agent:control",
  })
}
