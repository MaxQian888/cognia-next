/**
 * Built-in node executors — registered on first import of this module.
 * Each Phase 4 base executor handles the bare minimum to enable
 * end-to-end runs in tests and the Run button:
 *   • trigger.manual — passthrough of trigger payload
 *   • flow.set — write a value into the run's static-data variable
 *   • flow.branch — evaluate a condition expression, emit a decision
 *   • data.transform — small in-memory map/filter/reduce
 *   • ai.prompt — direct LLM call via the existing provider router
 *
 * Phase 6 adds the rest of the catalog. Until then, unregistered kinds
 * surface as "no executor registered" run failures.
 */
import type { Goal, GoalTemplate } from "@/types/goal"
import { registerNodeExecutor } from "../registry"
import { computeGoalAnalytics } from "@/lib/goal/analytics"
import { getGoalRuntime } from "@/lib/goal/runtime"
import {
  getActiveGoalForSession,
  getGoal,
  getOpenGoalForSession,
  listAllGoals,
  listGoalEvents,
  listGoalsBySession,
} from "@/lib/db/goals"
import {
  deleteGoalTemplate,
  getGoalTemplate,
  listGoalTemplates,
  setTemplateFavorite,
  upsertGoalTemplate,
} from "@/lib/db/goal-templates"
import { createGoalFromTemplate } from "@/lib/goal/templates"
import { seedGoalTemplates } from "@/lib/goal/seed-templates"
import { getSession } from "@/lib/db/sessions"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  applyGoalLimit,
  clampGoalEventLimit,
  clampGoalLimit,
  clampGoalTemplateLimit,
  goalLifecycleOutput,
  nonRetryable,
  parseGoalConfig,
  parseGoalTemplateConfig,
  requireGoalId,
  requireGoalSessionId,
  requireGoalTemplateId,
  toWorkflowGoal,
  toWorkflowGoalTemplate,
} from "../shared/executor-support"

// ── action.goal.* ──────────────────────────────────────────────────────────
// Goal nodes are workflow adapters over GoalRuntime. Mutations must keep
// using the runtime so abort controllers, audit rows, redaction, IM guardrails,
// plugin hooks, and terminal fan-out stay identical to slash/UI goal actions.
registerNodeExecutor({
  kind: "action.goal.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      sessionId?: string
      rawObjective?: string
      characterId?: string
      startPaused?: boolean
      config?: Record<string, unknown>
      configJson?: string
    }
    const sessionId = params.sessionId?.trim()
    const rawObjective = params.rawObjective?.trim()
    if (!sessionId) throw nonRetryable("action.goal.create requires 'sessionId'")
    if (!rawObjective) throw nonRetryable("action.goal.create requires non-empty 'rawObjective'")
    const config = parseGoalConfig(params)
    const goal = await getGoalRuntime().createGoal({
      sessionId,
      rawObjective,
      characterId: params.characterId?.trim() || undefined,
      startPaused: params.startPaused,
      config,
      appSettings: useSettingsStore.getState().settings,
      // Headless: no operator to hold turns for (ADR-0070 Phase 2).
      origin: "workflow",
    })
    return { output: { goalId: goal.id, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.get")
    const goal = await getGoal(goalId)
    return { output: { goalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: "all" | "session" | "activeForSession" | "openForSession"
      sessionId?: string
      limit?: number
    }
    const mode = params.mode ?? "all"
    const limit = clampGoalLimit(params.limit)
    let goals: Goal[]
    if (mode === "session") {
      const sessionId = requireGoalSessionId(params.sessionId, "action.goal.list")
      goals = applyGoalLimit(await listGoalsBySession(sessionId), limit)
    } else if (mode === "activeForSession") {
      const sessionId = requireGoalSessionId(params.sessionId, "action.goal.list")
      const goal = await getActiveGoalForSession(sessionId)
      goals = goal ? [goal] : []
    } else if (mode === "openForSession") {
      const sessionId = requireGoalSessionId(params.sessionId, "action.goal.list")
      const goal = await getOpenGoalForSession(sessionId)
      goals = goal ? [goal] : []
    } else {
      goals = await listAllGoals(limit)
    }
    const safeGoals = goals.map(toWorkflowGoal)
    return {
      output: {
        mode,
        count: safeGoals.length,
        goals: safeGoals,
        goal: safeGoals[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.events",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const goalId = requireGoalId(ctx, "action.goal.events")
    const limit = clampGoalEventLimit(params.limit)
    const events = await listGoalEvents(goalId, limit)
    return { output: { goalId, count: events.length, events } }
  },
})

registerNodeExecutor({
  kind: "action.goal.updateObjective",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { rawObjective?: string }
    const goalId = requireGoalId(ctx, "action.goal.updateObjective")
    const rawObjective = params.rawObjective?.trim()
    if (!rawObjective) {
      throw nonRetryable("action.goal.updateObjective requires non-empty 'rawObjective'")
    }
    const result = await getGoalRuntime().updateObjective(goalId, rawObjective)
    return {
      output: {
        goalId,
        changed: result !== null,
        goal: toWorkflowGoal(result?.goal ?? (await getGoal(goalId))),
        updatePrompt: result?.updatePrompt,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.pause",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.pause", (id) => getGoalRuntime().pauseGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.resume",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.resume", (id) => getGoalRuntime().resumeGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.stop",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.stop", (id) => getGoalRuntime().stopGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.preempt",
  typeVersion: 1,
  execute: async (ctx) =>
    goalLifecycleOutput(ctx, "action.goal.preempt", (id) => getGoalRuntime().preemptGoal(id)),
})

registerNodeExecutor({
  kind: "action.goal.updateConfig",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.updateConfig")
    const config = parseGoalConfig(
      ctx.params as { config?: Record<string, unknown>; configJson?: string }
    )
    if (Object.keys(config).length === 0) {
      throw nonRetryable("action.goal.updateConfig requires a non-empty config patch")
    }
    const goal = await getGoalRuntime().updateConfig(goalId, config)
    return { output: { goalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.decomposeSubgoals",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.decomposeSubgoals")
    const goal = await getGoal(goalId)
    if (!goal) return { output: { goalId, goal: null } }
    const session = await getSession(goal.sessionId)
    const client = buildRendererLlmClient({
      session,
      appSettings: useSettingsStore.getState().settings,
      featureId: "goal-subgoals",
    })
    if (!client) {
      throw nonRetryable("action.goal.decomposeSubgoals requires a configured judge model")
    }
    const updated = await getGoalRuntime().generateSubgoals(goalId, client)
    return { output: { goalId, goal: toWorkflowGoal(updated) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.toggleSubgoal",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { subgoalId?: string }
    const goalId = requireGoalId(ctx, "action.goal.toggleSubgoal")
    const subgoalId = params.subgoalId?.trim()
    if (!subgoalId) throw nonRetryable("action.goal.toggleSubgoal requires 'subgoalId'")
    const goal = await getGoalRuntime().toggleSubgoal(goalId, subgoalId)
    return { output: { goalId, subgoalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.clearSubgoals",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.clearSubgoals")
    const goal = await getGoalRuntime().clearSubgoals(goalId)
    return { output: { goalId, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const goalId = requireGoalId(ctx, "action.goal.delete")
    await getGoalRuntime().deleteGoal(goalId)
    return { output: { goalId, deleted: true } }
  },
})

registerNodeExecutor({
  kind: "action.goal.analytics",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      scope?: "all" | "session"
      sessionId?: string
      limit?: number
      windowDays?: number
    }
    const scope = params.scope ?? "all"
    const limit = clampGoalLimit(params.limit)
    const goals =
      scope === "session"
        ? applyGoalLimit(
            await listGoalsBySession(
              requireGoalSessionId(params.sessionId, "action.goal.analytics")
            ),
            limit
          )
        : await listAllGoals(limit)
    const analytics = computeGoalAnalytics(goals, { windowDays: params.windowDays })
    return { output: { scope, count: goals.length, analytics } }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      includeBuiltIn?: boolean
      favoriteOnly?: boolean
      query?: string
      limit?: number
    }
    await seedGoalTemplates()
    const query = params.query?.trim().toLocaleLowerCase()
    const limit = clampGoalTemplateLimit(params.limit)
    let templates = await listGoalTemplates()
    if (params.includeBuiltIn === false) templates = templates.filter((tpl) => !tpl.builtin)
    if (params.favoriteOnly) templates = templates.filter((tpl) => tpl.isFavorite)
    if (query) {
      templates = templates.filter((tpl) =>
        [tpl.id, tpl.title, tpl.objectiveText].some((value) =>
          value.toLocaleLowerCase().includes(query)
        )
      )
    }
    const safeTemplates = templates.slice(0, limit).map(toWorkflowGoalTemplate)
    return {
      output: {
        count: safeTemplates.length,
        templates: safeTemplates,
        template: safeTemplates[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.createGoal",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { templateId?: string; sessionId?: string; characterId?: string }
    const templateId = requireGoalTemplateId(ctx, "action.goal.template.createGoal")
    const sessionId = requireGoalSessionId(params.sessionId, "action.goal.template.createGoal")
    const goal = await createGoalFromTemplate({
      templateId,
      sessionId,
      characterId: params.characterId?.trim() || undefined,
      appSettings: useSettingsStore.getState().settings,
    })
    return { output: { templateId, goalId: goal.id, goal: toWorkflowGoal(goal) } }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.upsert",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      templateId?: string
      title?: string
      objectiveText?: string
      configJson?: string
      configOverrides?: Record<string, unknown>
      isFavorite?: boolean
      sortOrder?: number
    }
    const title = params.title?.trim()
    const objectiveText = params.objectiveText?.trim()
    if (!title) throw nonRetryable("action.goal.template.upsert requires non-empty 'title'")
    if (!objectiveText) {
      throw nonRetryable("action.goal.template.upsert requires non-empty 'objectiveText'")
    }
    const requestedId = params.templateId?.trim()
    const existing = requestedId ? await getGoalTemplate(requestedId) : undefined
    const cloneBuiltIn = existing?.builtin === true
    const now = Date.now()
    const row: GoalTemplate = {
      id: requestedId && !cloneBuiltIn ? requestedId : `gtpl_${crypto.randomUUID()}`,
      title,
      objectiveText,
      configOverrides: parseGoalTemplateConfig(params),
      builtin: false,
      isFavorite: params.isFavorite ?? existing?.isFavorite ?? false,
      sortOrder:
        typeof params.sortOrder === "number" && Number.isFinite(params.sortOrder)
          ? params.sortOrder
          : (existing?.sortOrder ?? 0),
      createdAt: existing && !cloneBuiltIn ? existing.createdAt : now,
      updatedAt: now,
    }
    const saved = await upsertGoalTemplate(row)
    return {
      output: {
        templateId: saved.id,
        sourceTemplateId: cloneBuiltIn ? requestedId : undefined,
        template: toWorkflowGoalTemplate(saved),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.favorite",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { isFavorite?: boolean }
    const templateId = requireGoalTemplateId(ctx, "action.goal.template.favorite")
    await setTemplateFavorite(templateId, Boolean(params.isFavorite))
    const template = await getGoalTemplate(templateId)
    return {
      output: {
        templateId,
        changed: template !== undefined,
        template: toWorkflowGoalTemplate(template),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.goal.template.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const templateId = requireGoalTemplateId(ctx, "action.goal.template.delete")
    const template = await getGoalTemplate(templateId)
    if (template?.builtin) {
      throw nonRetryable("cannot delete built-in goal template")
    }
    if (!template) return { output: { templateId, deleted: false } }
    await deleteGoalTemplate(templateId)
    return { output: { templateId, deleted: true } }
  },
})
