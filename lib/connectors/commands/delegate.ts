/**
 * `/delegate` — promote the turn that is already running into a delegated task.
 *
 * The mint path for `kind: "delegation"`. It deliberately does NOT start
 * anything: it takes the run this conversation already has in flight and says
 * "this one is going to take a while, treat it as a commitment". That is the
 * manual form of the promotion rule — a turn earns a delegation when there is
 * evidence it is long, not because someone guessed up front — and it is why
 * `adoptIntoDelegation` exists rather than the delegation having to be minted
 * before the work begins.
 *
 * What the person gets by promoting: a milestone list instead of a scrolling
 * tool log, a card that survives a reload, `steer:` to redirect it, and
 * `/handoff` to give it to someone. What they give up: nothing — the run keeps
 * executing, unchanged, under the same session.
 *
 * Bilingual literals, like every other command reply (see `render.ts`).
 */

import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { ExecutionRun } from "@/types/execution/run"

export interface DelegateCommandDeps {
  listBindings?: (conversationKey: string) => Promise<Array<{ runId: string }>>
  getRun?: (runId: string) => Promise<ExecutionRun | undefined>
  accept?: typeof import("@/lib/execution/delegation").acceptDelegation
  adopt?: typeof import("@/lib/execution/delegation").adoptIntoDelegation
  loadSession?: (conversationKey: string) => Promise<unknown>
}

export interface DelegateCommandInput {
  event: NormalizedInboundEvent
  arg: string
  reply: (
    text: string,
    outcome: "applied" | "denied" | "unknown",
    extra?: Record<string, unknown>
  ) => Promise<void>
  deps?: DelegateCommandDeps
}

/** Statuses in which a run can still be promoted — a settled run cannot. */
const PROMOTABLE = new Set(["queued", "running", "waiting", "paused", "recovery_required"])

/** Kinds worth promoting. A plan or a goal already has its own long-form surface. */
const PROMOTABLE_KINDS = new Set(["agent-turn", "team", "workflow"])

async function defaultListBindings(conversationKey: string) {
  const { getDb } = await import("@/lib/db/schema")
  const rows = await getDb()
    .executionRunBindings.where("conversationKey")
    .equals(conversationKey)
    .toArray()
  return rows
    .filter((row) => row.status === "active" || row.status === "degraded")
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((row) => ({ runId: row.runId }))
}

export async function handleDelegateCommand(input: DelegateCommandInput): Promise<void> {
  const deps = input.deps ?? {}
  const listBindings = deps.listBindings ?? defaultListBindings
  const getRun =
    deps.getRun ??
    (async (runId: string) => (await import("@/lib/db/execution-runs")).getExecutionRun(runId))

  let candidate: ExecutionRun | undefined
  let alreadyDelegated = false
  for (const binding of await listBindings(input.event.conversationKey)) {
    const run = await getRun(binding.runId)
    if (!run || !PROMOTABLE.has(run.status)) continue
    if (run.kind === "delegation") {
      alreadyDelegated = true
      break
    }
    if (!PROMOTABLE_KINDS.has(run.kind)) continue
    // A run that already belongs to a delegation is being carried, not stranded.
    if (run.parentRunId) {
      alreadyDelegated = true
      break
    }
    candidate = run
    break
  }

  if (alreadyDelegated) {
    await input.reply("这项工作已经是委派任务了 / That work is already a delegated task", "unknown")
    return
  }
  if (!candidate) {
    await input.reply(
      "此会话没有正在运行的任务可以委派 / Nothing is running in this chat to delegate",
      "unknown"
    )
    return
  }

  const [{ acceptDelegation, adoptIntoDelegation }, { findSessionByConversationKey }] =
    await Promise.all([
      import("@/lib/execution/delegation"),
      import("@/lib/connectors/session-bindings"),
    ])
  const accept = deps.accept ?? acceptDelegation
  const adopt = deps.adopt ?? adoptIntoDelegation
  const loadSession = deps.loadSession ?? findSessionByConversationKey
  const session = (await loadSession(input.event.conversationKey)) as
    Parameters<typeof acceptDelegation>[0]["session"] | undefined

  const title = input.arg.trim() || candidate.title
  const { runId } = await accept({
    // Keyed on the promoted run so a repeated `/delegate` on the same work is
    // the same commitment rather than a second card.
    delegationId: candidate.id,
    title,
    ...(candidate.projectId ? { projectId: candidate.projectId } : {}),
    ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
    initiator: {
      platformIdentityId: input.event.sender.id,
      remoteUserId: input.event.sender.remoteUserId,
      displayName: input.event.sender.displayName,
    },
    ...(session ? { session } : {}),
  })
  await adopt(candidate.id, runId)

  await input.reply(
    "已转为委派任务：会持续汇报，可回复「steer: …」调整、「/handoff」转交 / " +
      'Now a delegated task: it will report back — reply "steer: …" to redirect, "/handoff" to give it away',
    "applied"
  )
}
