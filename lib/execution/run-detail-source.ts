/** One run's existing journal and approval artifacts; no secondary read store. */
import { getDb } from "@/lib/db/schema"
import { getExecutionRun, listVisibleExecutionRunEvents } from "@/lib/db/execution-runs"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import { summarizeBotRunCost, type BotRunCostSummary } from "@/lib/bot/runtime/run-cost"
import type { ExecutionRun, ExecutionRunInterrupt, RunEvent } from "@/types/execution/run"
import type { BotHandlerResultV1 } from "@/types/bot/run"

export interface ExecutionRunDetailSources {
  run?: ExecutionRun
  events: RunEvent[]
  interrupts: ExecutionRunInterrupt[]
  botResult?: BotHandlerResultV1
  /** A Bot run's model spend from its cost ledger; absent when it made no model call. */
  botCost?: BotRunCostSummary
}

export async function readExecutionRunDetailSources(
  runId: string,
  includePrivate = false
): Promise<ExecutionRunDetailSources> {
  if (typeof runId !== "string" || !runId.trim() || runId.length > 256) {
    throw new Error("execution_run_detail requires a valid runId")
  }
  const run = await getExecutionRun(runId)
  if (!run) return { events: [], interrupts: [] }
  const [events, interrupts, result, cost] = await Promise.all([
    listVisibleExecutionRunEvents(runId, includePrivate),
    getDb().executionRunInterrupts.where("runId").equals(runId).toArray(),
    run.kind === "bot" ? getBotRunStep(runId, "__host:result") : undefined,
    run.kind === "bot" ? summarizeBotRunCost(runId) : undefined,
  ])
  return {
    run,
    events,
    interrupts: interrupts.sort((left, right) => right.createdAt - left.createdAt),
    ...(result?.status === "completed" ? { botResult: result.output as BotHandlerResultV1 } : {}),
    ...(cost && cost.invocations > 0 ? { botCost: cost } : {}),
  }
}
