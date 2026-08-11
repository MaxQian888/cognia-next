import type {
  AgentPlan,
  CreatePlanInput,
  PlanExecutionMode,
  PlanRefinementTrigger,
  PlanRefinementType,
  PlanSource,
  PlanStatus,
  PlanStepStatus,
} from "@/types/agent/plan"
import { registerNodeExecutor } from "../registry"
import { getPlanRuntime } from "@/lib/agent/plan/runtime"
import { listAllPlans, listPlanEvents } from "@/lib/db/plans"
import { getSession } from "@/lib/db/sessions"
import { buildRendererLlmClient } from "@/lib/ai/renderer-llm-client"
import { useSettingsStore } from "@/stores/settings/settings-store"
import {
  buildPlanDraftPatch,
  buildPlanStepPatch,
  clampPlanEventLimit,
  clampPlanLimit,
  nonRetryable,
  normalizePlanExecutionMode,
  normalizePlanRefinementTrigger,
  normalizePlanRefinementType,
  normalizePlanSource,
  normalizePlanStepStatus,
  parsePlanConfig,
  parsePlanCreateSteps,
  parsePlanMetadata,
  requirePlanId,
  requirePlanSessionId,
  toWorkflowPlan,
} from "../shared/executor-support"

// ── action.plan.* ─────────────────────────────────────────────────────────
registerNodeExecutor({
  kind: "action.plan.create",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      sessionId?: string
      characterId?: string
      title?: string
      description?: string
      source?: PlanSource
      executionMode?: PlanExecutionMode
      stepsJson?: string
      steps?: unknown
      configJson?: string
      config?: Record<string, unknown>
      metadataJson?: string
      metadata?: Record<string, unknown>
    }
    const sessionId = requirePlanSessionId(params.sessionId, "action.plan.create")
    const title = params.title?.trim()
    if (!title) throw nonRetryable("action.plan.create requires non-empty 'title'")
    const input: CreatePlanInput = {
      sessionId,
      title,
      source: normalizePlanSource(params.source),
      steps: parsePlanCreateSteps(params),
      ...(params.characterId?.trim() ? { characterId: params.characterId.trim() } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.executionMode
        ? { executionMode: normalizePlanExecutionMode(params.executionMode) }
        : {}),
      ...(parsePlanConfig(params) ? { config: parsePlanConfig(params) } : {}),
      ...(parsePlanMetadata(params) ? { metadata: parsePlanMetadata(params) } : {}),
    }
    const plan = await getPlanRuntime().createPlan(input)
    return { output: { planId: plan.id, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.get",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.get")
    const plan = await getPlanRuntime().getPlan(planId)
    return { output: { planId, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.list",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      mode?: "all" | "session" | "openForSession" | "executingForSession"
      sessionId?: string
      status?: PlanStatus | ""
      projectId?: string
      limit?: number
    }
    const mode = params.mode ?? "all"
    const limit = clampPlanLimit(params.limit)
    const runtime = getPlanRuntime()
    let plans: AgentPlan[]
    if (mode === "all") {
      plans = await listAllPlans(limit, params.projectId?.trim() || undefined)
    } else {
      const sessionId = requirePlanSessionId(params.sessionId, "action.plan.list")
      if (mode === "openForSession") {
        const plan = await runtime.getOpenPlanForSession(sessionId)
        plans = plan ? [plan] : []
      } else if (mode === "executingForSession") {
        const plan = await runtime.getExecutingPlanForSession(sessionId)
        plans = plan ? [plan] : []
      } else {
        plans = await runtime.listPlansBySession(sessionId)
      }
    }
    if (params.status) plans = plans.filter((plan) => plan.status === params.status)
    const safePlans = plans.slice(0, limit).map(toWorkflowPlan)
    return {
      output: {
        mode,
        count: safePlans.length,
        plans: safePlans,
        plan: safePlans[0] ?? null,
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.plan.events",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { limit?: number }
    const planId = requirePlanId(ctx, "action.plan.events")
    const events = await listPlanEvents(planId, clampPlanEventLimit(params.limit))
    return { output: { planId, count: events.length, events, event: events[0] ?? null } }
  },
})

registerNodeExecutor({
  kind: "action.plan.updateDraft",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      title?: string
      description?: string
      executionMode?: PlanExecutionMode | ""
      stepsJson?: string
      steps?: unknown
      configJson?: string
      config?: Record<string, unknown>
      metadataJson?: string
      metadata?: Record<string, unknown>
    }
    const planId = requirePlanId(ctx, "action.plan.updateDraft")
    const patch = buildPlanDraftPatch(params)
    if (Object.keys(patch).length === 0) {
      throw nonRetryable("action.plan.updateDraft requires at least one patch field")
    }
    const plan = await getPlanRuntime().updatePlanDraft(planId, patch)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.approve",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.approve")
    const plan = await getPlanRuntime().approvePlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.reject",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as { feedback?: string }
    const planId = requirePlanId(ctx, "action.plan.reject")
    const plan = await getPlanRuntime().rejectPlan(planId, params.feedback)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.refine",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      refinementType?: PlanRefinementType
      trigger?: PlanRefinementTrigger
      failedStepId?: string
      customInstructions?: string
    }
    const planId = requirePlanId(ctx, "action.plan.refine")
    const current = await getPlanRuntime().getPlan(planId)
    if (!current) return { output: { planId, changed: false, plan: null } }
    const session = await getSession(current.sessionId)
    const client = buildRendererLlmClient({
      session: session ?? null,
      appSettings: useSettingsStore.getState().settings,
      featureId: "plan-refine",
    })
    if (!client) {
      throw nonRetryable("action.plan.refine requires a configured planner model")
    }
    const refined = await getPlanRuntime().refinePlan(
      {
        planId,
        refinementType: normalizePlanRefinementType(params.refinementType),
        trigger: normalizePlanRefinementTrigger(params.trigger),
        ...(params.failedStepId?.trim() ? { failedStepId: params.failedStepId.trim() } : {}),
        ...(params.customInstructions?.trim()
          ? { customInstructions: params.customInstructions.trim() }
          : {}),
      },
      client,
      { signal: ctx.signal }
    )
    return {
      output: {
        planId,
        changed: refined !== null && refined.generationId !== current.generationId,
        plan: toWorkflowPlan(refined),
      },
    }
  },
})

registerNodeExecutor({
  kind: "action.plan.pause",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.pause")
    const plan = await getPlanRuntime().pausePlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.resume",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.resume")
    const plan = await getPlanRuntime().resumePlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.cancel",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.cancel")
    const plan = await getPlanRuntime().cancelPlan(planId)
    return { output: { planId, changed: plan !== null, plan: toWorkflowPlan(plan) } }
  },
})

registerNodeExecutor({
  kind: "action.plan.delete",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.delete")
    const existing = await getPlanRuntime().getPlan(planId)
    if (!existing) return { output: { planId, deleted: false } }
    await getPlanRuntime().deletePlan(planId)
    return { output: { planId, deleted: true } }
  },
})

registerNodeExecutor({
  kind: "action.plan.run",
  typeVersion: 1,
  execute: async (ctx) => {
    const planId = requirePlanId(ctx, "action.plan.run")
    const result = await getPlanRuntime().runPlan(planId, { signal: ctx.signal })
    if (!result) throw nonRetryable(`action.plan.run: plan ${planId} not found`)
    return { output: { planId, status: result.status, result: result.output } }
  },
})

registerNodeExecutor({
  kind: "action.plan.setStepStatus",
  typeVersion: 1,
  execute: async (ctx) => {
    const params = ctx.params as {
      stepId?: string
      status?: PlanStepStatus
      result?: string
      error?: string
      outputJson?: string
      output?: unknown
      attempts?: number
    }
    const planId = requirePlanId(ctx, "action.plan.setStepStatus")
    const stepId = params.stepId?.trim()
    if (!stepId) throw nonRetryable("action.plan.setStepStatus requires 'stepId'")
    const status = normalizePlanStepStatus(params.status)
    const patch = buildPlanStepPatch(params)
    const plan = await getPlanRuntime().setStepStatus(planId, stepId, status, patch)
    return {
      output: { planId, stepId, status, changed: plan !== null, plan: toWorkflowPlan(plan) },
    }
  },
})

// ── action.plan.step.dispatch ─────────────────────────────────────────────
// Per ADR-0045 P2. Synthesizer-emitted node: one per PlanStep. Looks up the
// per-run PlanRunContext (registered by `runPlan` before runWorkflow) and
// delegates to `dispatchPlanStepNode`, which marks the step in_progress, runs
// the kind-specific work (agent_turn / approval_gate / sub_workflow), and
// writes the terminal status back. Retryable so the orchestrator re-runs
// transient failures per the plan's error policy.
registerNodeExecutor({
  kind: "action.plan.step.dispatch",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => {
    const params = ctx.params as { planId?: string; stepId?: string }
    if (!params.planId || !params.stepId) {
      throw nonRetryable("action.plan.step.dispatch requires 'planId' and 'stepId'")
    }
    const [{ getPlanRunContext }, { dispatchPlanStepNode }] = await Promise.all([
      import("@/lib/agent/plan/plan-run-context"),
      import("@/lib/agent/plan/step-dispatch"),
    ])
    const runCtx = getPlanRunContext(ctx.runId)
    if (!runCtx) {
      throw nonRetryable(
        `action.plan.step.dispatch: no PlanRunContext registered for runId=${ctx.runId}`
      )
    }
    return dispatchPlanStepNode(runCtx, params.stepId, ctx.signal)
  },
})
