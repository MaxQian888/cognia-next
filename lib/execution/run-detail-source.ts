/** One run's existing journal and approval artifacts; no secondary read store. */
import { getDb } from "@/lib/db/schema"
import { getExecutionRun, listVisibleExecutionRunEvents } from "@/lib/db/execution-runs"
import { getBotRunStep } from "@/lib/db/bot-run-steps"
import type { ExecutionRun, ExecutionRunInterrupt, RunEvent } from "@/types/execution/run"
import type { BotHandlerResultV1 } from "@/types/bot/run"

export interface ExecutionRunDetailSources {
  run?: ExecutionRun
  events: RunEvent[]
  interrupts: ExecutionRunInterrupt[]
  botResult?: BotHandlerResultV1
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
  const [events, interrupts, result] = await Promise.all([
    listVisibleExecutionRunEvents(runId, includePrivate),
    getDb().executionRunInterrupts.where("runId").equals(runId).toArray(),
    run.kind === "bot" ? getBotRunStep(runId, "__host:result") : undefined,
  ])
  return {
    run,
    events,
    interrupts: interrupts.sort((left, right) => right.createdAt - left.createdAt),
    ...(result?.status === "completed" ? { botResult: result.output as BotHandlerResultV1 } : {}),
  }
}
