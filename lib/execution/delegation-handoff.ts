/**
 * Handing a delegation to a person.
 *
 * The brief is a PROJECTION, not a new table. Everything a person needs in
 * order to pick the work up is already in the journal — what was asked, who
 * asked, what is done, what was tried, where it stuck, what decision is
 * outstanding, what came out of it. Copying that into a handoff record would
 * create a second source of truth that goes stale the moment the run moves.
 *
 * Two existing envelopes were considered and rejected:
 *
 *  - `HandoffEnvelope` is a parent→child handoff INSIDE one run, and its
 *    validator rejects URLs and absolute paths. That is right for a machine
 *    recipient and wrong for a human, whose first question is "where exactly
 *    did it stop?"
 *  - `ThreadHandoffTicket` moves a conversation between HOSTS. It says nothing
 *    about who owns the work.
 *
 * The handoff does NOT terminate the delegation. That is the whole point: the
 * commitment is still open, the thread it reports to is still the thread the
 * person is answering in, and handing it back is a control on the same run
 * rather than a new request.
 */

import {
  getExecutionRun,
  listChildExecutionRuns,
  listExecutionRunBindings,
  runEventJournal,
  semanticRunEvent,
} from "@/lib/db/execution-runs"
import { getDb } from "@/lib/db/schema"
import { sanitizeActivityLabel } from "@/lib/execution/run-activity"
import type {
  ExecutionRunInitiator,
  ExecutionRunInterrupt,
  ExecutionRunStatus,
  RunActivitySnapshot,
  RunArtifactSnapshot,
  RunProgressSnapshot,
  RunStepSnapshot,
} from "@/types/execution/run"

/** How long a handoff may sit before the surface starts calling it overdue. */
export const HANDOFF_SLA_MS = 24 * 60 * 60 * 1_000

export interface DelegationHandoffBrief {
  runId: string
  title: string
  status: ExecutionRunStatus
  /** Who asked for the work, if the run recorded an initiator. */
  requestedBy?: ExecutionRunInitiator
  startedAt: number
  elapsedMs: number
  progress: RunProgressSnapshot
  /** Milestones already settled — "what is done". */
  done: RunStepSnapshot[]
  /** Milestones in flight — "what was mid-way when it stopped". */
  inFlight: RunStepSnapshot[]
  /** Milestones never started — "what is left". */
  notStarted: RunStepSnapshot[]
  /** The safe execution timeline — "what was tried". */
  tried: RunActivitySnapshot[]
  blockedOn: {
    /** Only ever populated for the desktop rendering; see `renderHandoffBrief`. */
    error?: string
    waitingReason?: string
    failedSteps: RunStepSnapshot[]
  }
  awaitingDecision?: {
    id: string
    title: string
    type: ExecutionRunInterrupt["type"]
    createdAt: number
    expiresAt: number
  }
  artifacts: RunArtifactSnapshot[]
  /** The engine runs carrying the work, so the reader knows what to look at. */
  children: Array<{ id: string; kind: string; title: string; status: ExecutionRunStatus }>
}

/**
 * Assemble the brief from what the run already knows.
 *
 * Reads only projected, sanitized state (`latestSnapshot` plus the visible
 * event stream), so the brief inherits the reducer's redaction rather than
 * re-deriving it from raw payloads.
 */
export async function buildDelegationHandoffBrief(
  runId: string
): Promise<DelegationHandoffBrief | undefined> {
  const run = await getExecutionRun(runId)
  if (!run) return undefined
  const snapshot = run.latestSnapshot
  const steps = [
    ...(snapshot?.activeSteps ?? []),
    ...(snapshot?.recentSteps ?? []),
    ...(snapshot?.pendingSteps ?? []),
  ]
  const pending = await getDb()
    .executionRunInterrupts.where("[runId+status]")
    .equals([runId, "pending"])
    .toArray()
  // Oldest pending decision first: it is the one that has been blocking longest.
  const decision = pending.sort((left, right) => left.createdAt - right.createdAt)[0]
  const children = await listChildExecutionRuns(runId)

  return {
    runId,
    title: sanitizeActivityLabel(run.title, "Delegated task"),
    status: snapshot?.status ?? run.status,
    ...(run.initiator ? { requestedBy: run.initiator } : {}),
    startedAt: run.startedAt,
    elapsedMs: snapshot?.elapsedMs ?? Math.max(0, run.updatedAt - run.startedAt),
    progress: snapshot?.progress ?? { completed: 0, total: 0, trustworthy: false },
    done: steps.filter((step) => step.status === "completed"),
    inFlight: steps.filter((step) => step.status === "in_progress"),
    notStarted: steps.filter((step) => step.status === "pending" || step.status === "blocked"),
    tried: snapshot?.activities ?? [],
    blockedOn: {
      ...(snapshot?.error ? { error: snapshot.error } : {}),
      ...(snapshot?.waitingReason ? { waitingReason: snapshot.waitingReason } : {}),
      failedSteps: steps.filter((step) => step.status === "failed"),
    },
    ...(decision
      ? {
          awaitingDecision: {
            id: decision.id,
            title: sanitizeActivityLabel(decision.title, "Decision required"),
            type: decision.type,
            createdAt: decision.createdAt,
            expiresAt: decision.expiresAt,
          },
        }
      : {}),
    artifacts: snapshot?.artifacts ?? [],
    children: children.map((child) => ({
      id: child.id,
      kind: child.kind,
      title: sanitizeActivityLabel(child.title, "Run"),
      status: child.status,
    })),
  }
}

export interface RenderHandoffBriefOptions {
  zh?: boolean
  /**
   * IM rendering. Drops `blockedOn.error` — the reducer's `error` is the last
   * failure message, which can carry a stack, and the same reasoning already
   * keeps it out of the stopped-run note every platform receives. The reader
   * gets `waitingReason` plus the unfinished remainder, which is what actually
   * tells them where to pick up.
   */
  imSafe?: boolean
}

function stepLines(steps: readonly RunStepSnapshot[], limit = 6): string[] {
  return steps.slice(0, limit).map((step) => `  - ${step.title}`)
}

/** One builder, two renderings — desktop keeps full fidelity, IM does not. */
export function renderHandoffBrief(
  brief: DelegationHandoffBrief,
  options: RenderHandoffBriefOptions = {}
): string {
  const zh = options.zh === true
  const t = (en: string, cn: string) => (zh ? cn : en)
  const lines: string[] = [`# ${brief.title}`]

  const who = brief.requestedBy?.displayName
  const minutes = Math.round(brief.elapsedMs / 60_000)
  lines.push(
    who
      ? t(`Requested by ${who} · running ${minutes} min`, `${who} 发起 · 已运行 ${minutes} 分钟`)
      : t(`Running ${minutes} min`, `已运行 ${minutes} 分钟`)
  )

  const { completed, total, trustworthy } = brief.progress
  lines.push(
    trustworthy
      ? t(`Progress: ${completed}/${total}`, `进度：${completed}/${total}`)
      : t(`Progress: ${completed} done`, `进度：已完成 ${completed} 项`)
  )

  if (brief.done.length > 0) {
    lines.push("", t("## Done", "## 已完成"), ...stepLines(brief.done))
  }
  if (brief.inFlight.length > 0) {
    lines.push("", t("## In flight", "## 进行中"), ...stepLines(brief.inFlight))
  }
  if (brief.notStarted.length > 0) {
    lines.push("", t("## Not started", "## 尚未开始"), ...stepLines(brief.notStarted))
  }

  const blocked: string[] = []
  if (brief.blockedOn.waitingReason) blocked.push(`  - ${brief.blockedOn.waitingReason}`)
  if (!options.imSafe && brief.blockedOn.error) blocked.push(`  - ${brief.blockedOn.error}`)
  for (const step of brief.blockedOn.failedSteps.slice(0, 3)) blocked.push(`  - ${step.title}`)
  if (blocked.length > 0) {
    lines.push("", t("## Stuck on", "## 卡在哪"), ...blocked)
  }

  if (brief.awaitingDecision) {
    lines.push(
      "",
      t("## Waiting on a decision", "## 等待决定"),
      `  - ${brief.awaitingDecision.title}`
    )
  }

  if (brief.artifacts.length > 0) {
    lines.push(
      "",
      t("## Produced", "## 产出"),
      ...brief.artifacts.slice(0, 6).map((artifact) => `  - ${artifact.title}`)
    )
  }

  if (!options.imSafe && brief.tried.length > 0) {
    lines.push(
      "",
      t("## Tried", "## 已尝试"),
      ...brief.tried.slice(-8).map((activity) => `  - ${activity.label}`)
    )
  }

  return lines.join("\n")
}

export interface HandOffDelegationInput {
  runId: string
  assignee: { kind: "human"; id?: string; label?: string }
  actor?: ExecutionRunInitiator
  /** SLA window; on expiry the handoff is marked overdue, never forgotten. */
  slaMs?: number
  now?: number
  /** Injected in tests; the delivery half is a connector concern. */
  deliverBrief?: (input: {
    conversationKey: string
    adapterId: string
    brief: DelegationHandoffBrief
    idempotencyKey: string
  }) => Promise<void>
}

export interface HandOffDelegationResult {
  handedOff: boolean
  interruptId?: string
  reason?: "run_not_found" | "not_a_delegation" | "already_handed_off" | "terminal"
}

function handoffInterruptId(runId: string, now: number): string {
  return `handoff:${runId}:${now}`
}

/**
 * Park the delegation on a person.
 *
 * Ordered so a crash at any point leaves a state someone can still act on, and
 * the one irreversible-looking step is compensated: if assigning fails after
 * the interrupt is recorded, the interrupt is resolved back out and the run
 * resumed, rather than leaving a delegation waiting on a human nobody told.
 */
export async function handOffDelegationToHuman(
  input: HandOffDelegationInput
): Promise<HandOffDelegationResult> {
  const run = await getExecutionRun(input.runId)
  if (!run) return { handedOff: false, reason: "run_not_found" }
  if (run.kind !== "delegation") return { handedOff: false, reason: "not_a_delegation" }
  if (["completed", "failed", "cancelled"].includes(run.status)) {
    return { handedOff: false, reason: "terminal" }
  }

  const existing = await getDb()
    .executionRunInterrupts.where("[runId+status]")
    .equals([input.runId, "pending"])
    .toArray()
  if (existing.some((interrupt) => interrupt.type === "human_handoff")) {
    return { handedOff: false, reason: "already_handed_off" }
  }

  const now = input.now ?? Date.now()
  const interruptId = handoffInterruptId(input.runId, now)
  const label = input.assignee.label ?? input.assignee.id ?? "a teammate"
  const { createRunInterrupt, resolveRunInterruptFromSource } =
    await import("@/lib/execution/run-control")
  await createRunInterrupt({
    id: interruptId,
    runId: input.runId,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    type: "human_handoff",
    status: "pending",
    title: `Handed to ${label}`,
    expiresAt: now + (input.slaMs ?? HANDOFF_SLA_MS),
    createdAt: now,
  })

  const bindings = await listExecutionRunBindings(input.runId)
  const binding = bindings.find((candidate) => candidate.status === "active") ?? bindings[0]
  try {
    if (binding && input.deliverBrief) {
      const brief = await buildDelegationHandoffBrief(input.runId)
      if (brief) {
        await input.deliverBrief({
          conversationKey: binding.conversationKey,
          adapterId: binding.adapterId,
          brief,
          idempotencyKey: `delegation-handoff:${input.runId}:${interruptId}`,
        })
      }
    }
    if (binding) {
      const { setAssignee } = await import("@/lib/db/conversation-overrides")
      await setAssignee(binding.conversationKey, input.assignee, {
        adapterId: binding.adapterId,
        via: "delegation-handoff",
      })
    }
  } catch (error) {
    // Compensate: a delegation waiting on a human nobody was told about is the
    // one outcome worse than not handing off at all.
    await resolveRunInterruptFromSource(input.runId, interruptId, "deny", input.actor, now)
    await runEventJournal
      .append(
        input.runId,
        semanticRunEvent(
          "run.resumed",
          { reason: "handoff_failed" },
          { ts: now, sourceEventId: `handoff:${interruptId}:compensated` }
        )
      )
      .catch(() => undefined)
    throw error
  }

  return { handedOff: true, interruptId }
}

export interface ResumeHandoffInput {
  runId: string
  interruptId: string
  actor?: ExecutionRunInitiator
  now?: number
}

/**
 * Hand the work back.
 *
 * Resolving the interrupt is what unblocks the run — `interrupt.resolved`
 * already means "running" to the reducer — and clearing the assignee runs
 * `setAssignee`'s own restore path, which gives back the mode and routing the
 * assignment had overridden. Any note travels as a steer, through the same
 * gate as every other correction, and never into the journal.
 */
export async function resumeDelegationHandoff(
  input: ResumeHandoffInput
): Promise<{ resumed: boolean }> {
  const interrupt = await getDb().executionRunInterrupts.get(input.interruptId)
  if (!interrupt || interrupt.runId !== input.runId || interrupt.status !== "pending") {
    return { resumed: false }
  }
  if (interrupt.type !== "human_handoff") return { resumed: false }

  const now = input.now ?? Date.now()
  const { resolveRunInterruptFromSource } = await import("@/lib/execution/run-control")
  await resolveRunInterruptFromSource(input.runId, input.interruptId, "approve", input.actor, now)

  const bindings = await listExecutionRunBindings(input.runId)
  const binding = bindings.find((candidate) => candidate.status === "active") ?? bindings[0]
  if (binding) {
    const { setAssignee } = await import("@/lib/db/conversation-overrides")
    await setAssignee(binding.conversationKey, null, {
      adapterId: binding.adapterId,
      via: "delegation-handoff-return",
    })
  }
  return { resumed: true }
}

/**
 * Mark an overdue handoff instead of expiring it.
 *
 * `recoverPendingRunInterrupts` expires anything past its deadline, which is
 * right for a tool approval — nobody answered, deny and move on — and wrong
 * for a handoff: expiring it would silently un-assign work a person still owns
 * and resume an agent on a task somebody else is mid-way through. The deadline
 * is an SLA here, so it produces a visible `run.degraded` (once, by
 * `sourceEventId`) and the interrupt stays pending.
 */
export async function markOverdueHandoffs(now: number = Date.now()): Promise<number> {
  const pending = await getDb().executionRunInterrupts.where("status").equals("pending").toArray()
  let marked = 0
  for (const interrupt of pending) {
    if (interrupt.type !== "human_handoff" || interrupt.expiresAt > now) continue
    try {
      await runEventJournal.append(
        interrupt.runId,
        semanticRunEvent(
          "run.degraded",
          { reason: "handoff_overdue", interruptId: interrupt.id },
          { ts: now, sourceEventId: `handoff:${interrupt.id}:overdue` }
        )
      )
      marked += 1
    } catch {
      // The run settled while the handoff was outstanding. Nothing to say.
    }
  }
  return marked
}
