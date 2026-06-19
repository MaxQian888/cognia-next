/**
 * `plan` scheduled-task executor.
 *
 * Runs an existing AgentPlan (ADR-0045) to terminal via
 * `getPlanRuntime().runPlan`. Plans persist in Dexie (`agentPlans`), so a
 * cron/interval/event schedule can re-run the same plan id across app
 * restarts. The task's AbortSignal (timeout / overlap-cancel) is forwarded
 * straight into `runPlan`, which honors it through the workflow orchestrator.
 *
 * When `replanOnFailure` is set, a failed run triggers the runtime's capped
 * auto-replan (Devin-style repair) — that needs an LLM client, which we build
 * with the shared utility-client factory.
 */

import type { PlanTaskPayload, ScheduledTask, TaskExecution } from "@/types/scheduler"
import { loggers } from "@/lib/logging"

const log = loggers.scheduler

interface PlanExecutionResult {
  success: boolean
  output?: Record<string, unknown>
  error?: string
}

export async function executePlanTask(
  task: ScheduledTask,
  execution: TaskExecution,
  signal: AbortSignal
): Promise<PlanExecutionResult> {
  const payload = (task.payload ?? {}) as Partial<PlanTaskPayload>
  if (!payload.planId || !payload.planId.trim()) {
    return { success: false, error: "plan task requires `planId` in payload" }
  }

  if (signal?.aborted) {
    return { success: false, error: "Plan task aborted before start" }
  }

  const { getPlanRuntime } = await import("@/lib/agent/plan/runtime")

  // Optional LLM client for step-failure auto-replan. Built lazily so a plan
  // without `replanOnFailure` never spins one up.
  let client: import("@/lib/twin/distill/llm").LlmClient | undefined
  if (payload.replanOnFailure) {
    try {
      const [{ buildUtilityLlmClient }, { getSettings }] = await Promise.all([
        import("@/lib/ai/generation/utility-client"),
        import("@/lib/db/settings"),
      ])
      const appSettings = await getSettings().catch(() => null)
      client =
        buildUtilityLlmClient({
          session: null,
          appSettings,
          featureId: "scheduler-plan-replan",
        }) ?? undefined
    } catch (err) {
      log.warn("Scheduler plan task: failed to build replan client; continuing without", {
        taskId: task.id,
        err: String(err),
      })
    }
  }

  log.info("Scheduler plan task → runPlan", {
    taskId: task.id,
    executionId: execution.id,
    planId: payload.planId,
  })

  try {
    const result = await getPlanRuntime().runPlan(payload.planId, {
      signal,
      ...(client ? { client } : {}),
    })

    if (!result) {
      return { success: false, error: `Plan not found or not runnable: ${payload.planId}` }
    }

    return {
      success: result.status === "completed",
      output: { planId: payload.planId, status: result.status, result: result.output },
      ...(result.status === "completed"
        ? {}
        : { error: `Plan ended with status: ${result.status}` }),
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
