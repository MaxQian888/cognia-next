/**
 * Run a published workflow deployment.
 *
 * Through `executeDeployedWorkflow`, never the draft orchestrator: a Bot runs
 * an IMMUTABLE artifact with its dependencies locked, so what fires at 3am is
 * the workflow that was reviewed and not whatever the editor last saved.
 *
 * `entrypoint: "bot"` rather than borrowing `"trigger"`, so admission can scope
 * a Bot differently from a person at a keyboard and run history can tell the
 * two apart afterwards.
 */

import type { WorkflowTriggeredFrom } from "@/types/workflow/visual"

import { BotExecutorUnavailableError, type BotExecutorContext, type BotExecutorFn } from "./types"

export interface WorkflowExecutorDeps {
  execute?: (input: {
    workflowId: string
    entrypoint: "bot"
    caller: string
    idempotencyKey: string
    triggerKind: "trigger.integration.event"
    triggerId?: string
    payload: unknown
    signal?: AbortSignal
    triggeredBy: WorkflowTriggeredFrom
    traceId?: string
  }) => Promise<{ runId?: string }>
}

/** The origin a Bot-driven workflow run records. */
export function botTriggeredFrom(ctx: BotExecutorContext): WorkflowTriggeredFrom {
  return {
    source: "bot",
    ...(ctx.event.binding?.conversationKey
      ? { conversationKey: ctx.event.binding.conversationKey }
      : {}),
    ...(ctx.event.binding?.adapterId ? { adapterId: ctx.event.binding.adapterId } : {}),
    ...(ctx.definition.character ? { characterId: ctx.definition.character } : {}),
    // The verified human behind the event, when the source proved one. An
    // unverified guess here would widen who may tap Approve on anything the
    // workflow asks.
    ...(ctx.event.actor?.principalId || ctx.event.actor?.id
      ? {
          initiator: {
            ...(ctx.event.actor.id ? { platformIdentityId: ctx.event.actor.id } : {}),
            ...(ctx.event.actor.displayName ? { displayName: ctx.event.actor.displayName } : {}),
            ...(ctx.event.actor.principalId ? { principalId: ctx.event.actor.principalId } : {}),
            ...(ctx.event.actor.accountId ? { accountId: ctx.event.actor.accountId } : {}),
          },
        }
      : {}),
  }
}

export function createWorkflowBotExecutor(deps: WorkflowExecutorDeps = {}): BotExecutorFn {
  return async (ctx) => {
    const workflowId = ctx.definition.workflow
    if (!workflowId) {
      throw new BotExecutorUnavailableError(
        "workflow",
        `Bot "${ctx.definition.id}" declares executor "workflow" without a workflow id`
      )
    }

    const execute =
      deps.execute ??
      (async (input) => {
        const { executeDeployedWorkflow } =
          await import("@/lib/workflow/runtime/execution-authority")
        return executeDeployedWorkflow(input)
      })

    const result = await execute({
      workflowId,
      entrypoint: "bot",
      caller: `bot:${ctx.installation.id}`,
      // The Bot run id, so a redelivered event cannot start the workflow twice.
      idempotencyKey: ctx.runId,
      triggerKind: "trigger.integration.event",
      triggerId: ctx.event.triggerId,
      payload: { event: ctx.event, config: ctx.config },
      signal: ctx.signal,
      triggeredBy: botTriggeredFrom(ctx),
      ...(ctx.event.traceId ? { traceId: ctx.event.traceId } : {}),
    })

    return {
      summary: `Workflow ${workflowId} started`,
      output: { workflowRunId: result.runId },
    }
  }
}

export const runWorkflowBot = createWorkflowBotExecutor()
