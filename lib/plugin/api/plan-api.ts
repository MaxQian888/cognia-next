/**
 * Plugin Plan API — lets plugins read and drive `AgentPlan`s (ADR-0045).
 *
 * The plan hub is the app's canonical IR for multi-step agentic work, and it
 * was the only one of the three decompose-and-drive engines with no plugin
 * surface: `ctx.goals` and `ctx.team` shipped, `ctx.plans` did not — so a
 * plugin could start a goal or a team but could not see, approve, or run the
 * plan those very engines project into.
 *
 * Design (mirrors `goal-api.ts` deliberately):
 *  - Reads go straight to the `@/lib/db/plans` Dexie layer.
 *  - Mutations route through `getPlanRuntime()` so the runtime's side-effects
 *    fire (one-open-plan-per-session invariant, event log, abort registry,
 *    companion + scheduler + notification fan-out). Nothing is reimplemented.
 *  - Refinement needs a planner-capable LLM; the same renderer client the
 *    plan console uses is built here so plugins don't thread a model.
 *  - Gated by `plan:read` (reads) / `plan:write` (mutations).
 */

import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { getPlan, listAllPlans, listPlanEvents, listPlansBySession } from "@/lib/db/plans"
import { getSession } from "@/lib/db/sessions"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { PluginPlanAPI } from "@cognia/plugin-contract/lib/plugin/api/plan-api"
export type { PluginPlanAPI } from "@cognia/plugin-contract/lib/plugin/api/plan-api"

/** Thrown when a refinement has no planner-capable model to use. */
export class NoPlannerModelError extends Error {
  constructor() {
    super("ctx.plans.refine: no planner-capable model is configured — replanning is unavailable.")
    this.name = "NoPlannerModelError"
  }
}

/**
 * Create the Plan API for a plugin. Reads need `plan:read`; every mutation
 * needs `plan:write` (enforced via the PermissionGuard proxy).
 */
export function createPlanAPI(pluginId: string): PluginPlanAPI {
  const runtime = getPlanRuntime()

  const api: PluginPlanAPI = {
    // reads
    get: async (planId) => (await getPlan(planId)) ?? null,
    listBySession: (sessionId) => listPlansBySession(sessionId),
    listAll: (limit) => listAllPlans(limit),
    getOpenForSession: async (sessionId) =>
      (await runtime.getOpenPlanForSession(sessionId)) ?? null,
    getExecutingForSession: async (sessionId) =>
      (await runtime.getExecutingPlanForSession(sessionId)) ?? null,
    getEvents: (planId, limit) => listPlanEvents(planId, limit),

    // mutations
    create: (input) => runtime.createPlan(input),
    updateDraft: (planId, patch) => runtime.updatePlanDraft(planId, patch),
    approve: (planId) => runtime.approvePlan(planId),
    reject: (planId, feedback) => runtime.rejectPlan(planId, feedback),
    start: async (planId) => {
      const started = await runtime.startPlan(planId)
      return started ? { strategy: started.strategy, status: started.status } : null
    },
    run: (planId) => runtime.runPlan(planId),
    pause: (planId) => runtime.pausePlan(planId),
    resume: (planId) => runtime.resumePlan(planId),
    cancel: (planId) => runtime.cancelPlan(planId),
    setStepStatus: (planId, stepId, status, result) =>
      runtime.setStepStatus(planId, stepId, status, result ? { result } : {}),
    refine: async (planId, type, instructions) => {
      const plan = await getPlan(planId)
      if (!plan) return null
      const session = await getSession(plan.sessionId)
      const client = buildRendererLlmClient({
        session,
        appSettings: useSettingsStore.getState().settings,
        featureId: "plan-refine",
      })
      if (!client) throw new NoPlannerModelError()
      return runtime.refinePlan(
        {
          planId,
          refinementType: type,
          // A plugin-driven replan is a deliberate act, not the runtime's own
          // failure recovery — `manual` is what bypasses the auto-refinement
          // budget, exactly as the UI's refine buttons do.
          trigger: "manual",
          ...(instructions ? { customInstructions: instructions } : {}),
        },
        client
      )
    },
    delete: (planId) => runtime.deletePlan(planId),
  }

  return createGuardedAPI(pluginId, api, {
    get: "plan:read",
    listBySession: "plan:read",
    listAll: "plan:read",
    getOpenForSession: "plan:read",
    getExecutingForSession: "plan:read",
    getEvents: "plan:read",
    create: "plan:write",
    updateDraft: "plan:write",
    approve: "plan:write",
    reject: "plan:write",
    start: "plan:write",
    run: "plan:write",
    pause: "plan:write",
    resume: "plan:write",
    cancel: "plan:write",
    setStepStatus: "plan:write",
    refine: "plan:write",
    delete: "plan:write",
  })
}
