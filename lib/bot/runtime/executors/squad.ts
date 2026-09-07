/**
 * Run a Squad.
 *
 * Through the shared `startSquadRun` primitive, with `origin: "bot"` and a
 * plan-approval delegate wired to the Bot's own `step.waitForApproval`.
 *
 * The delegate matters. Without one, a headless origin fails a plan gate fast
 * on the premise that there is nobody to ask, which is right for a bare 3am
 * script and wrong here: a Bot run parks on a run interrupt that reaches the
 * same decision surface every other approval does. Supplying the delegate is
 * the proof that a channel exists.
 */

import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"
import type { BotStepApiV1 } from "@/types/bot/run"

import { BotRunParkedError, BOT_PARK_INTERVAL_MS } from "../step"
import { botTriggeredFrom } from "./workflow"
import { BotExecutorUnavailableError, type BotExecutorContext, type BotExecutorFn } from "./types"

/**
 * The shape a Bot needs from the shared Squad primitive. Structural rather
 * than an import of `StartSquadRunInput`, so a test can inject a fake without
 * pulling the orchestration graph into its module tree.
 */
export interface SquadStartInput {
  squadId: string
  goal: string
  origin: string
  triggeredFrom: WorkflowTriggeredFrom
  /**
   * The run id to launch under.
   *
   * Supplied, never minted. `startSquadRun` is idempotent per `runId`, so a Bot
   * that omits it gets a fresh id on every re-entry and the primitive answers
   * `already_running` against the run the previous attempt started. A Bot run is
   * re-entered from the top by design, so that is not an edge case.
   */
  runId?: string
  characterId?: string
  planApprovalDelegate?: (request: {
    planText: string
    revision: number
    riskReason?: string
  }) => Promise<unknown> | unknown
}

export interface SquadExecutorDeps {
  start?: (input: SquadStartInput) => Promise<{
    started: boolean
    runId?: string
    reason?: string
    /** True when `runId` was already launched and this call was a replay. */
    duplicate?: boolean
  }>
  /**
   * A step API whose waits BLOCK rather than park.
   *
   * `startSquadRun` invokes `planApprovalDelegate` from a fire-and-forget
   * lifecycle, so by the time a plan needs approving this executor has already
   * returned and its delivery is parked. A park thrown from there would unwind
   * into a detached promise and be lost, taking the approval with it.
   */
  blockingStep?: (ctx: BotExecutorContext) => BotStepApiV1
  /**
   * Has the Squad run this Bot dispatched reached a terminal state?
   *
   * The Bot run's lifetime is the Squad's, not the dispatch's. `startSquadRun`
   * returns as soon as the run id is reserved, so settling here would mark the
   * card complete while the Squad was still working, and the plan-approval
   * delegate would then be asking a question on a run the journal had closed.
   */
  isSquadRunSettled?: (squadRunId: string) => Promise<boolean> | boolean
  now?: () => number
}

/**
 * The objective a Squad is handed.
 *
 * The event is described, never inlined as instructions: its payload is
 * whoever opened the pull request or sent the message, and a Squad that reads
 * it as its own objective is a Squad taking orders from a stranger.
 */
export function squadObjective(ctx: BotExecutorContext): string {
  const prompt = typeof ctx.config.objective === "string" ? ctx.config.objective.trim() : ""
  if (prompt) return prompt
  const resource = ctx.event.resource
  return resource
    ? `Handle ${ctx.event.type} on ${resource.kind} ${resource.id}${resource.scope ? ` in ${resource.scope}` : ""}`
    : `Handle ${ctx.event.type}`
}

export function createSquadBotExecutor(deps: SquadExecutorDeps = {}): BotExecutorFn {
  return async (ctx) => {
    const squadId = ctx.definition.team
    if (!squadId) {
      throw new BotExecutorUnavailableError(
        "squad",
        `Bot "${ctx.definition.id}" declares executor "squad" without a team id`
      )
    }

    const blockingStep =
      deps.blockingStep ??
      ((context: BotExecutorContext) => {
        // Built lazily: the module graph for the step API is not worth loading
        // for a Squad whose plan gate never fires.
        let api: BotStepApiV1 | undefined
        const resolve = async () => {
          if (api) return api
          const { createBotStepApi } = await import("../step")
          api = createBotStepApi({
            runId: context.runId,
            signal: context.signal,
            deps: { waitMode: "block" },
          })
          return api
        }
        return {
          run: async (name, fn) => (await resolve()).run(name, fn),
          waitForApproval: async (name, request) =>
            (await resolve()).waitForApproval(name, request),
          waitForEvent: async (name, waitInput) => (await resolve()).waitForEvent(name, waitInput),
        } satisfies BotStepApiV1
      })

    const isSettled =
      deps.isSquadRunSettled ??
      (async (squadRunId: string) => {
        const [{ agentTeamExecutionRunId }, { TERMINAL_RUN_STATUSES }, { getDb }] =
          await Promise.all([
            import("@/lib/execution/agent-team-bridge"),
            import("@/lib/execution/run-control"),
            import("@/lib/db/schema"),
          ])
        const row = await getDb().executionRuns.get(agentTeamExecutionRunId(squadRunId))
        // No row yet means the Squad has not journalled itself, which is not
        // the same as finished. Parking is the safe answer.
        return row ? TERMINAL_RUN_STATUSES.has(row.status) : false
      })

    const start =
      deps.start ??
      (async (input) => {
        const { startSquadRun } = await import("@/lib/ai/agent/team/start-squad-run")
        return startSquadRun(input)
      })

    // Memoized, so a re-entry does not re-dispatch. `startSquadRun` is
    // idempotent per run id and would answer `duplicate`, but paying for the
    // round trip every twenty seconds for the life of a Squad is waste.
    const result = await ctx.step.run("squad-start", () =>
      start({
        squadId,
        goal: squadObjective(ctx),
        origin: "bot",
        // Derived from the delivery, so a re-entry lands on the run the
        // previous attempt started instead of forking a second one.
        runId: ctx.runId,
        triggeredFrom: botTriggeredFrom(ctx),
        ...(ctx.definition.character ? { characterId: ctx.definition.character } : {}),
        planApprovalDelegate: async (request) => {
          const decision = await blockingStep(ctx).waitForApproval("squad-plan", {
            title: `Approve the plan for ${ctx.definition.name}?`,
            // The plan text is rendered as DATA on the decision surface, never
            // folded into the title, which is the line a person skims.
            detail: { plan: request.planText, revision: request.revision },
            ...(request.riskReason ? { message: request.riskReason } : {}),
            risk: "medium",
          })
          return decision.outcome === "approved"
        },
      })
    )

    if (!result.started) {
      throw new Error(`Squad ${squadId} did not start (${result.reason ?? "unknown"})`)
    }

    const squadRunId = result.runId
    if (squadRunId && !(await isSettled(squadRunId))) {
      throw new BotRunParkedError(
        ctx.runId,
        "squad-settle",
        (deps.now ?? Date.now)() + BOT_PARK_INTERVAL_MS,
        `squad:${squadRunId}`
      )
    }

    return {
      summary: `Squad ${squadId} finished`,
      output: { squadRunId },
    }
  }
}

export const runSquadBot = createSquadBotExecutor()
