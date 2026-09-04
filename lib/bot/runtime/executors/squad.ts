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
  }>
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

    const start =
      deps.start ??
      (async (input) => {
        const { startSquadRun } = await import("@/lib/ai/agent/team/start-squad-run")
        return startSquadRun(input)
      })

    const result = await start({
      squadId,
      goal: squadObjective(ctx),
      origin: "bot",
      triggeredFrom: botTriggeredFrom(ctx),
      ...(ctx.definition.character ? { characterId: ctx.definition.character } : {}),
      planApprovalDelegate: async (request) => {
        const decision = await ctx.step.waitForApproval("squad-plan", {
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

    if (!result.started) {
      throw new Error(`Squad ${squadId} did not start (${result.reason ?? "unknown"})`)
    }
    return { summary: `Squad ${squadId} started`, output: { squadRunId: result.runId } }
  }
}

export const runSquadBot = createSquadBotExecutor()
