/**
 * `/handoff` — park the open delegation on a person, and hand it back.
 *
 * The reachable half of `lib/execution/delegation-handoff.ts`. It lives beside
 * `goal.ts` and `schedule.ts` rather than inside `dispatch.ts` for the same
 * reason those do: a subcommand grammar plus a durable side effect is more
 * than a `case` should carry.
 *
 * Scoped to the conversation's own open delegation, found through the run
 * BINDING. That is deliberate: the binding is what makes a run belong to this
 * thread, and it is the same lookup `callback-authorization` uses — so
 * `/handoff` can never reach a run the caller could not already control from
 * here.
 *
 * Bilingual literals, like every other command reply: the bus runs headless in
 * the webview with no next-intl context (see `render.ts`).
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ExecutionRun } from "@/types/execution/run"

export interface HandoffCommandDeps {
  listBindings?: (conversationKey: string) => Promise<Array<{ runId: string; adapterId: string }>>
  getRun?: (runId: string) => Promise<ExecutionRun | undefined>
  listPendingInterrupts?: (
    runId: string
  ) => Promise<Array<{ id: string; type: string; createdAt: number }>>
  handOff?: typeof import("@/lib/execution/delegation-handoff").handOffDelegationToHuman
  execute?: typeof import("@/lib/execution/run-control").executeRunControlCommand
  operatorIds?: readonly string[]
}

export interface HandoffCommandInput {
  event: NormalizedInboundEvent
  arg: string
  reply: (
    text: string,
    outcome: "applied" | "denied" | "unknown",
    extra?: Record<string, unknown>
  ) => Promise<void>
  deps?: HandoffCommandDeps
}

const OPEN = new Set(["queued", "running", "waiting", "paused", "recovery_required"])

async function defaultListBindings(conversationKey: string) {
  const { getDb } = await import("@/lib/db/schema")
  const rows = await getDb()
    .executionRunBindings.where("conversationKey")
    .equals(conversationKey)
    .toArray()
  return rows
    .filter((row) => row.status === "active" || row.status === "degraded")
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((row) => ({ runId: row.runId, adapterId: row.adapterId }))
}

async function defaultListPendingInterrupts(runId: string) {
  const { getDb } = await import("@/lib/db/schema")
  return getDb().executionRunInterrupts.where("[runId+status]").equals([runId, "pending"]).toArray()
}

/** The newest open delegation this thread can see, if any. */
async function findOpenDelegation(
  conversationKey: string,
  deps: HandoffCommandDeps
): Promise<ExecutionRun | undefined> {
  const listBindings = deps.listBindings ?? defaultListBindings
  const getRun =
    deps.getRun ??
    (async (runId: string) => (await import("@/lib/db/execution-runs")).getExecutionRun(runId))
  for (const binding of await listBindings(conversationKey)) {
    const run = await getRun(binding.runId)
    if (run?.kind === "delegation" && OPEN.has(run.status)) return run
  }
  return undefined
}

export async function handleHandoffCommand(input: HandoffCommandInput): Promise<void> {
  const deps = input.deps ?? {}
  const arg = input.arg.trim()
  const run = await findOpenDelegation(input.event.conversationKey, deps)
  if (!run) {
    await input.reply(
      "此会话没有进行中的委派任务 / No delegated task is running in this chat",
      "unknown"
    )
    return
  }

  const listPending = deps.listPendingInterrupts ?? defaultListPendingInterrupts
  const pending = await listPending(run.id)
  const handoff = pending.find((interrupt) => interrupt.type === "human_handoff")

  const [head, ...rest] = arg.split(/\s+/)
  const isReturn = head?.toLowerCase() === "back" || head === "交还"

  if (isReturn) {
    if (!handoff) {
      await input.reply("该任务没有交给任何人 / That task is not handed off", "unknown")
      return
    }
    const execute =
      deps.execute ??
      (async (
        ...args: Parameters<typeof import("@/lib/execution/run-control").executeRunControlCommand>
      ) => (await import("@/lib/execution/run-control")).executeRunControlCommand(...args))
    const note = rest.join(" ").trim()
    const result = await execute(
      {
        runId: run.id,
        action: "resume",
        idempotencyKey: `handoff-back:${input.event.messageId}`,
        expectedRevision: run.currentRevision,
        actor: {
          platformIdentityId: input.event.sender.id,
          remoteUserId: input.event.sender.remoteUserId,
          displayName: input.event.sender.displayName,
        },
        interruptId: handoff.id,
        ...(note ? { steerMessage: note } : {}),
      },
      { operatorIds: [...(deps.operatorIds ?? [])] }
    )
    await input.reply(
      result.accepted
        ? "已交还，任务继续 / Handed back, the task continues"
        : "交还未被接受 / The handback was not accepted",
      result.accepted ? "applied" : "denied",
      result.accepted ? undefined : { reason: result.reason }
    )
    return
  }

  if (handoff) {
    await input.reply("该任务已经交给别人了 / That task is already handed off", "unknown")
    return
  }

  // No argument means "I am taking this" — the common case in a direct chat,
  // and the only reading that needs no name resolution at all.
  const label = arg || input.event.sender.displayName || input.event.sender.remoteUserId
  const handOff =
    deps.handOff ??
    (async (
      ...args: Parameters<
        typeof import("@/lib/execution/delegation-handoff").handOffDelegationToHuman
      >
    ) => (await import("@/lib/execution/delegation-handoff")).handOffDelegationToHuman(...args))
  const outcome = await handOff({
    runId: run.id,
    assignee: {
      kind: "human",
      ...(input.event.sender.remoteUserId && !arg ? { id: input.event.sender.remoteUserId } : {}),
      ...(label ? { label } : {}),
    },
    actor: {
      platformIdentityId: input.event.sender.id,
      remoteUserId: input.event.sender.remoteUserId,
      displayName: input.event.sender.displayName,
    },
    deliverBrief: await defaultBriefDeliverer(),
  })

  await input.reply(
    outcome.handedOff
      ? `已交给 ${label} / Handed to ${label}。回复「/handoff back」交还 / reply "/handoff back" to take it back`
      : "无法交接该任务 / That task cannot be handed off",
    outcome.handedOff ? "applied" : "unknown",
    outcome.handedOff ? undefined : { reason: outcome.reason }
  )
}

/**
 * Deliver the brief into the same thread the run reports to.
 *
 * IM rendering, so the brief drops `blockedOn.error` — that field is the last
 * failure message and can carry a stack, which is exactly why the stopped-run
 * note every platform receives does not print it either.
 */
async function defaultBriefDeliverer() {
  const [{ renderHandoffBrief }, { enqueueGoverned }, { getDb }] = await Promise.all([
    import("@/lib/execution/delegation-handoff"),
    import("@/lib/connectors/delivery-gateway"),
    import("@/lib/db/schema"),
  ])
  return async (input: {
    conversationKey: string
    adapterId: string
    brief: import("@/lib/execution/delegation-handoff").DelegationHandoffBrief
    idempotencyKey: string
  }): Promise<void> => {
    const binding = (
      await getDb()
        .executionRunBindings.where("conversationKey")
        .equals(input.conversationKey)
        .toArray()
    ).find((row) => row.runId === input.brief.runId)
    const conversationRef = binding?.deliveryTarget?.conversationRef
    if (!conversationRef) return
    await enqueueGoverned({
      adapterId: input.adapterId,
      conversationKey: input.conversationKey,
      request: {
        conversationRef,
        ...(binding?.deliveryTarget ? { deliveryTarget: binding.deliveryTarget } : {}),
        segments: [
          {
            type: "text",
            text: renderHandoffBrief(input.brief, {
              imSafe: true,
              zh: binding?.locale?.toLowerCase().startsWith("zh") === true,
            }),
          },
        ],
        metadata: { idempotencyKey: input.idempotencyKey },
      },
      source: "ai-run",
    })
  }
}
