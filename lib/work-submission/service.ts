/**
 * Work submission acceptance (ADR-0123).
 *
 * One function matters here: {@link acceptWorkSubmission}. It turns "the user
 * pressed send" into durable state in a **single Dexie transaction**, so there
 * is no window in which a user can see a message that the system has no record
 * of owing an answer for.
 *
 * The transaction commits, together:
 *
 *   • the caller's transcript write (injected, see `writeTranscript`)
 *   • the `workSubmissions` row that owes a dispatch
 *   • the frozen `workInputBatches` row a retry must replay
 *   • the `ExecutionRun`, opened as `queued`
 *
 * The run deliberately does **not** start here. `run.started` projects a run to
 * `running` (`lib/execution/run-reducer.ts`), which would be a lie for work that
 * is accepted but still waiting for a runner — `queued` is what that state is
 * called. {@link markWorkSubmissionStarted} emits it at dispatch instead. Work
 * parked because its target is away journals `run.waiting` at acceptance.
 *
 * Everything else — waking a runner, broadcasting, notifying the UI — happens
 * strictly *after* commit, because a listener that reacts to work the database
 * has not yet accepted can observe state that a rollback then erases.
 *
 * ## Why the context bundle is not written here
 *
 * The model-side input is final early (once prompt hooks and redaction have
 * run); the execution context is not settled until immediately before dispatch,
 * when the working directory, task workspace, and route are known. Freezing
 * both at one point would be wrong for one of them. So acceptance freezes the
 * input, and {@link bindWorkExecutionContext} freezes the context later under a
 * write-once guard.
 */

import {
  isSuccessfulOutcome,
  validateWorkSubmissionIntentV1,
  type WorkAttachmentRefV1,
  type WorkReceiptV1,
  type WorkSpecAuthorityV1,
  type WorkSubmissionIntentV1,
  type WorkTerminalOutcomeV1,
  WORK_SUBMISSION_CONTRACT_VERSION,
} from "@cognia/agent-config-types/work-submission"
import { hostStateDigest } from "@cognia/agent-config-types/host-state"
import type { SendOptions } from "@cognia/agent-config-types"

import { appendRunEventInsideTransaction, semanticRunEvent } from "@/lib/db/execution-runs"
import { getDb, withDbReopenRetry } from "@/lib/db/schema"
import {
  bindExecutionContextBundle,
  countOpenWorkSubmissions,
  findWorkSubmissionByIdempotencyKey,
  settleWorkSubmissionRow,
  WORK_SUBMISSION_PAYLOAD_TTL_MS,
  type ExecutionContextBundleRow,
  type WorkInputBatchRow,
  type WorkSubmissionRow,
} from "@/lib/db/work-submissions"

import { sealWorkSubmissionPayload, type WorkSubmissionCryptoDeps } from "./crypto"

/**
 * Backlog ceiling per account.
 *
 * Mirrors `MAX_PENDING_HOST_STATE_ACTIONS` so a client outbox and the work
 * ledger fill up at the same point instead of one silently absorbing what the
 * other rejected.
 */
export const MAX_OPEN_WORK_SUBMISSIONS = 1000
const WORK_SUBMISSION_ASSEMBLY_GRACE_MS = 30_000

export class WorkSubmissionRejectedError extends Error {
  constructor(
    readonly code: "invalid_intent" | "backlog_full",
    readonly details: string[]
  ) {
    super(`Work submission rejected (${code}): ${details.join("; ")}`)
    this.name = "WorkSubmissionRejectedError"
  }
}

/** The plaintext frozen at acceptance. Never persisted unencrypted. */
export interface FrozenWorkInput {
  /** Exactly what the model will be sent, after hooks and redaction. */
  content: unknown
  visibleMessageIds: string[]
  attachments: WorkAttachmentRefV1[]
}

/** The plaintext execution context frozen just before dispatch. */
export interface FrozenExecutionContext {
  cwd?: string
  workspaceBindingRef?: string
  baseRef?: string
  projectId?: string
  /** Exact host dispatch options; replay must not resolve them from live state. */
  sendOptions?: SendOptions
  /** Anything else the host needs to re-materialize the same surroundings. */
  detail?: Record<string, unknown>
}

export interface AcceptWorkSubmissionInput {
  intent: WorkSubmissionIntentV1
  runId: string
  turnId: string
  inputBatchId: string
  submissionId: string
  input: FrozenWorkInput
  runTitle?: string
  /**
   * Whether the target can be dispatched to right now. When false, a `wait`
   * policy parks the submission as `blocked` and records `run.waiting` rather
   * than pretending the turn started.
   */
  targetAvailable?: boolean
  /**
   * Transcript write, executed **inside** the acceptance transaction. Any Dexie
   * operation performed here joins that transaction automatically, so the user
   * message and the submission commit or roll back together.
   */
  writeTranscript?: () => Promise<void>
  now?: number
}

export interface WorkSubmissionServiceDeps extends WorkSubmissionCryptoDeps {
  now?: () => number
}

/** Stable digest of the frozen input, so a replay can be proven identical. */
export function workInputDigest(input: FrozenWorkInput): string {
  return hostStateDigest({
    content: input.content,
    visibleMessageIds: input.visibleMessageIds,
    attachments: input.attachments,
  })
}

export function executionContextDigest(context: FrozenExecutionContext): string {
  return hostStateDigest(context)
}

function receiptFor(row: WorkSubmissionRow): WorkReceiptV1 {
  return {
    contractVersion: WORK_SUBMISSION_CONTRACT_VERSION,
    submissionId: row.id,
    runId: row.runId,
    turnId: row.turnId,
    inputBatchId: row.inputBatchId,
    state:
      row.dispatchState === "settled"
        ? "terminal"
        : row.dispatchState === "blocked"
          ? "blocked"
          : row.dispatchState === "pending"
            ? "accepted"
            : "queued",
    acceptedAt: row.createdAt,
  }
}

/**
 * Durably accept a unit of work and return its receipt.
 *
 * Idempotent by `[accountId + idempotencyKey]`: a redelivered client action,
 * a double-tapped send, or a re-queued outbox entry all resolve to the original
 * receipt rather than producing a second message, run, or task.
 */
export async function acceptWorkSubmission(
  input: AcceptWorkSubmissionInput,
  deps: WorkSubmissionServiceDeps = {}
): Promise<WorkReceiptV1> {
  const validation = validateWorkSubmissionIntentV1(input.intent)
  if (!validation.ok) throw new WorkSubmissionRejectedError("invalid_intent", validation.errors)

  const intent = validation.value
  const { accountId } = intent.scope

  // Idempotency is checked before any work is done so a redelivery is cheap
  // and, critically, cannot re-run `writeTranscript`.
  const existing = await findWorkSubmissionByIdempotencyKey(accountId, intent.idempotencyKey)
  if (existing) return receiptFor(existing)

  if ((await countOpenWorkSubmissions(accountId)) >= MAX_OPEN_WORK_SUBMISSIONS) {
    throw new WorkSubmissionRejectedError("backlog_full", [
      `account has ${MAX_OPEN_WORK_SUBMISSIONS} unsettled submissions`,
    ])
  }

  const now = input.now ?? deps.now?.() ?? Date.now()
  const available = input.targetAvailable ?? true
  // `wait` is the only policy that parks work for later; the others surface the
  // unavailability to their caller instead of accumulating a backlog.
  const blocked = !available && intent.availabilityPolicy === "wait"

  // Sealing happens before the transaction: encryption is async and CPU-bound,
  // and holding an IndexedDB transaction open across it would risk the
  // transaction auto-committing while we wait.
  const envelope = await sealWorkSubmissionPayload(
    JSON.stringify(input.input),
    { accountId, submissionId: input.submissionId, kind: "input-batch" },
    deps
  )

  const submission: WorkSubmissionRow = {
    id: input.submissionId,
    accountId,
    idempotencyKey: intent.idempotencyKey,
    runId: input.runId,
    turnId: input.turnId,
    ...(intent.scope.sessionId ? { sessionId: intent.scope.sessionId } : {}),
    ...(intent.scope.projectId ? { projectId: intent.scope.projectId } : {}),
    runtimeTargetId: intent.scope.runtimeTargetId,
    sourceKind: intent.source.kind,
    sourceId: intent.source.sourceId,
    ...(intent.source.triggerId ? { triggerId: intent.source.triggerId } : {}),
    availabilityPolicy: intent.availabilityPolicy,
    dispatchState: blocked ? "blocked" : "pending",
    // A live caller still has to freeze its final SendOptions and claim the row
    // after this transaction commits. Keep the background outbox out of that
    // short assembly window; if the caller crashes, the row becomes eligible
    // after the grace period and recovery takes over.
    nextAttemptAt: blocked ? now : now + WORK_SUBMISSION_ASSEMBLY_GRACE_MS,
    attemptCount: 0,
    inputBatchId: input.inputBatchId,
    createdAt: now,
    updatedAt: now,
  }

  const batch: WorkInputBatchRow = {
    id: input.inputBatchId,
    submissionId: input.submissionId,
    digest: workInputDigest(input.input),
    visibleMessageIds: input.input.visibleMessageIds,
    attachments: input.input.attachments,
    envelope,
    createdAt: now,
    expiresAt: now + WORK_SUBMISSION_PAYLOAD_TTL_MS,
  }

  const committed = await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction(
      "rw",
      // The transcript stores, so an injected `writeTranscript` commits with
      // the submission. The scope is the transitive closure of
      // `commitMessageDelta`, not just the three tables it names: image
      // ingest reaches `messageMedia`, and resolving a session with no
      // project reaches `settings` and `projects`. A Dexie sub-transaction
      // may only narrow its parent's scope, so anything it can touch has to
      // be listed here or the write throws on exactly the paths — attachments,
      // first-run sessions — that are hardest to notice.
      [
        db.messages,
        db.messageMedia,
        db.messageMediaRefs,
        db.sessions,
        db.settings,
        db.projects,
        db.workSubmissions,
        db.workInputBatches,
        db.executionContextBundles,
        db.executionRuns,
        db.executionRunEvents,
      ],
      async (): Promise<WorkSubmissionRow> => {
        // Re-check inside the transaction: two concurrent accepts of the same
        // key would both pass the read above, and only the unique index would
        // stop the second — after `writeTranscript` had already run.
        const raced = await db.workSubmissions
          .where("[accountId+idempotencyKey]")
          .equals([accountId, intent.idempotencyKey])
          .first()
        if (raced) return raced

        await input.writeTranscript?.()
        await db.workSubmissions.add(submission)
        await db.workInputBatches.add(batch)
        await db.executionRuns.add({
          id: input.runId,
          kind: "agent-turn",
          sourceId: input.submissionId,
          ...(intent.scope.sessionId ? { sessionId: intent.scope.sessionId } : {}),
          ...(intent.scope.projectId ? { projectId: intent.scope.projectId } : {}),
          title: input.runTitle ?? "Chat run",
          status: blocked ? "waiting" : "queued",
          currentRevision: 0,
          startedAt: now,
          updatedAt: now,
        })
        // Only the blocked case journals an event here. Accepted-but-not-yet-
        // dispatched work is exactly what `queued` means, and `run.started`
        // would project the run to `running` (see `lib/execution/run-reducer`)
        // before anything is actually running. The runner emits `run.started`
        // when it dispatches.
        if (blocked) {
          await appendRunEventInsideTransaction(
            db,
            input.runId,
            semanticRunEvent(
              "run.waiting",
              { reason: "target_unavailable", submissionId: input.submissionId },
              { ts: now }
            )
          )
        }
        return submission
      }
    )
  })

  return receiptFor(committed)
}

export interface BindWorkExecutionContextInput {
  submissionId: string
  accountId: string
  contextBundleId: string
  context: FrozenExecutionContext
  executionFingerprint?: string
  specAuthority?: WorkSpecAuthorityV1
  now?: number
}

/**
 * Freeze the execution context, once.
 *
 * Returns the id actually in force. On a retry the stored bundle wins and the
 * caller must dispatch against *that* context — re-resolving the project root
 * or workspace against the host's current state is the exact drift this guard
 * exists to prevent.
 */
export async function bindWorkExecutionContext(
  input: BindWorkExecutionContextInput,
  deps: WorkSubmissionServiceDeps = {}
): Promise<{ bound: boolean; contextBundleId: string }> {
  const now = input.now ?? deps.now?.() ?? Date.now()
  const envelope = await sealWorkSubmissionPayload(
    JSON.stringify(input.context),
    { accountId: input.accountId, submissionId: input.submissionId, kind: "context-bundle" },
    deps
  )
  const bundle: Omit<ExecutionContextBundleRow, "submissionId"> = {
    id: input.contextBundleId,
    digest: executionContextDigest(input.context),
    ...(input.context.projectId ? { projectId: input.context.projectId } : {}),
    ...(input.context.workspaceBindingRef
      ? { workspaceBindingRef: input.context.workspaceBindingRef }
      : {}),
    ...(input.context.baseRef ? { baseRef: input.context.baseRef } : {}),
    envelope,
    createdAt: now,
    expiresAt: now + WORK_SUBMISSION_PAYLOAD_TTL_MS,
  }
  return bindExecutionContextBundle(
    input.submissionId,
    bundle,
    {
      ...(input.executionFingerprint ? { executionFingerprint: input.executionFingerprint } : {}),
      ...(input.specAuthority ? { specAuthority: input.specAuthority } : {}),
    },
    now
  )
}

/**
 * Record that a claimed submission has actually been handed to a runtime.
 *
 * This is where `run.started` belongs: it projects the run to `running`, which
 * is only true once something is running. Idempotent, so a redelivered dispatch
 * does not append a second start.
 */
export async function markWorkSubmissionStarted(submissionId: string, now: number): Promise<void> {
  await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction(
      "rw",
      db.workSubmissions,
      db.executionRuns,
      db.executionRunEvents,
      async () => {
        const row = await db.workSubmissions.get(submissionId)
        if (!row || row.dispatchState === "settled") return
        await db.workSubmissions.put({ ...row, dispatchState: "dispatched", updatedAt: now })

        const run = await db.executionRuns.get(row.runId)
        if (!run || run.status === "running") return
        if (["completed", "failed", "cancelled"].includes(run.status)) return
        await appendRunEventInsideTransaction(
          db,
          row.runId,
          semanticRunEvent("run.started", { surface: row.sourceKind, submissionId }, { ts: now })
        )
      }
    )
  })
}

export interface SettleWorkSubmissionInput {
  submissionId: string
  outcome: WorkTerminalOutcomeV1
  errorCode?: string
  /**
   * Terminal transcript write, executed inside the settle transaction. Runs
   * only for the caller that wins the settle race, which is what makes "write
   * the assistant message exactly once" hold across the four call sites that
   * can observe a turn ending.
   */
  writeTranscript?: () => Promise<void>
  now?: number
}

/**
 * Seal a submission and its run together.
 *
 * Returns whether this call sealed it. A second caller gets `false` and its
 * `writeTranscript` never runs, so a duplicate terminal event cannot produce a
 * duplicate assistant message.
 */
export async function settleWorkSubmission(
  input: SettleWorkSubmissionInput,
  deps: WorkSubmissionServiceDeps = {}
): Promise<boolean> {
  const now = input.now ?? deps.now?.() ?? Date.now()

  const sealed = await withDbReopenRetry(() => {
    const db = getDb()
    return db.transaction(
      "rw",
      [
        db.messages,
        db.messageMediaRefs,
        db.sessions,
        db.workSubmissions,
        db.executionRuns,
        db.executionRunEvents,
      ],
      async (): Promise<boolean> => {
        const row = await db.workSubmissions.get(input.submissionId)
        if (!row || row.dispatchState === "settled") return false

        await input.writeTranscript?.()
        await db.workSubmissions.put({
          ...row,
          dispatchState: "settled",
          terminalOutcome: input.outcome,
          leaseOwner: undefined,
          leaseExpiresAt: undefined,
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          settledAt: now,
          updatedAt: now,
        })

        const run = await db.executionRuns.get(row.runId)
        const alreadyTerminal = run && ["completed", "failed", "cancelled"].includes(run.status)
        if (run && !alreadyTerminal) {
          await appendRunEventInsideTransaction(
            db,
            row.runId,
            semanticRunEvent(
              runEventForOutcome(input.outcome),
              {
                submissionId: input.submissionId,
                outcome: input.outcome,
                ...(input.errorCode ? { errorCode: input.errorCode } : {}),
              },
              { ts: now }
            )
          )
        }
        return true
      }
    )
  })

  return sealed
}

function runEventForOutcome(outcome: WorkTerminalOutcomeV1) {
  if (outcome === "cancelled") return "run.cancelled" as const
  if (outcome === "recovery_required") return "run.recovery_required" as const
  return isSuccessfulOutcome(outcome) ? ("run.completed" as const) : ("run.failed" as const)
}

/**
 * Fall back to the row-level settle when there is no transcript to write.
 *
 * Kept distinct from {@link settleWorkSubmission} so a caller that only needs
 * to close the ledger does not open a transaction over the message stores.
 */
export async function settleWorkSubmissionWithoutTranscript(
  submissionId: string,
  outcome: WorkTerminalOutcomeV1,
  now: number,
  errorCode?: string
): Promise<boolean> {
  return settleWorkSubmissionRow(submissionId, outcome, now, errorCode)
}
