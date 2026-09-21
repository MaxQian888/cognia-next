/**
 * The Router + Fusion ledger store — the ONLY writer of money (ADR-0188).
 *
 * Every mutation runs one pure plan from `@cognia/router-fusion`'s planner
 * inside ONE read-write IndexedDB transaction over exactly the stores it
 * touches, and persists the plan's `next` state together with its ledger rows,
 * run events and outbox effects. IndexedDB serializes overlapping read-write
 * transactions, which is what makes concurrent run creation (BUD-01) and
 * concurrent call admission (BUD-10) race-free without an in-memory lock.
 *
 * Invariants kept here, not by callers:
 * - no reservation, no dispatch: `markDispatched` requires a PREPARED attempt of
 *   a running, un-fenced run;
 * - an effect is booked once: every ledger row has a deterministic dedupe key;
 * - a dispatched call is never assumed free: without an answer it becomes
 *   UNKNOWN and its money stays held until reconciled;
 * - actual cost is booked in full: overspend is recorded and freezes the run;
 * - terminal is terminal: finalize and cancel race inside the transaction and
 *   exactly one wins (REC-04);
 * - a stale worker is fenced: state changes carry the fencing token, money from
 *   the outside world is still booked (REC-02).
 *
 * Content (committed call output) is sealed BEFORE a transaction opens and read
 * AFTER it commits — WebCrypto awaits would otherwise commit the transaction.
 */

import {
  applyTenantRelease,
  assertAttemptTransition,
  assertRunTransition,
  canTransitionRun,
  isTerminalRunStatus,
  normalizeUsage,
  planCallReservation,
  planMarkUncertain,
  planReleaseReservation,
  planRunCreation,
  planSettle,
  planStageReservation,
  planTerminalRelease,
  priceUsage,
  runAvailableMicrousd,
  sha256Hex,
  uuidFromName,
  UsageInconsistentError,
  type BudgetRefusalCode,
  type CallLedgerPort,
  type CommittedCallResult,
  type CompiledFusionConfig,
  type DataClass,
  type PrepareCallInput,
  type PrepareOutcome,
  type ReservationSnapshot,
  type RouteDecision,
  type RunStatus,
  type SettleCallInput,
  type SettleOutcome,
  type StoredArtifact,
  type TaskKind,
  type ToolIntent,
  type VerifierProfile,
  type ArtifactStore,
  type EventSink,
} from "@cognia/router-fusion"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"

import type { FusionContentCodec } from "./content-codec"
import type { FusionDB } from "./fusion-db"
import { ARTIFACT_CONTENT_TTL_MS } from "./retention"
import { fusionRunSummaryOf } from "./run-summary"
import type {
  FusionAccountRow,
  FusionCallAttemptRow,
  FusionCostStatus,
  FusionLedgerKind,
  FusionOutboxKind,
  FusionReservationRow,
  FusionRunDriver,
  FusionRunError,
  FusionRunEventRow,
  FusionRunOrigin,
  FusionRunRow,
} from "./types"
import type { ExecutionRunOrigin } from "@/types/execution/run"

/**
 * Which fusion-run origins arrive with no execution run of their own, and what
 * the cockpit should call the place they came from.
 *
 * `null` means the work already owns an execution run — a routed chat turn is
 * still that turn's run, an `ai.prompt` node is still the workflow's — so
 * projecting a second row would double-count one piece of work in every list
 * that reads the account database. Only the external Run API arrives with
 * nothing behind it — and a chat cascade or panel (B3), which the orchestrator
 * drives instead of a sidecar turn; see `projectedOriginOf`.
 */
const PROJECTED_RUN_ORIGIN: Record<FusionRunOrigin, ExecutionRunOrigin | null> = {
  chat: null,
  gatewayPassthrough: null,
  agent: null,
  workflow: null,
  utility: null,
  // A paired phone or browser asked THIS device to do the work (WP-C). No
  // local engine stands behind it, so without a projection the run would be
  // invisible in `/agent-runs` and unstoppable from the machine doing it.
  // `local` rather than `gateway-api`: the companion is the same person at
  // another screen, not an external program holding a key.
  companion: "local",
  gateway: "gateway-api",
}

/**
 * The cockpit origin of a run, or `null` when an engine already owns its
 * execution run. A chat run the orchestrator drives is a cascade or panel turn:
 * no sidecar turn and no direct-chat execution run stand behind it, so it is
 * projected as local work the cockpit can show and stop. A companion run is
 * projected for the same reason.
 */
export function projectedOriginOf(
  run: Pick<FusionRunRow, "origin" | "driver">
): ExecutionRunOrigin | null {
  if (run.origin === "chat" && run.driver === "orchestrator") return "local"
  return PROJECTED_RUN_ORIGIN[run.origin]
}

/**
 * Whether the ledger writes a run's usage rows. A direct chat turn writes its
 * own, keyed by the assistant message; a chat run the orchestrator drives has
 * no such turn, so its calls are projected like every other surface's.
 */
export function ledgerWritesUsageRows(run: Pick<FusionRunRow, "origin" | "driver">): boolean {
  return run.origin !== "chat" || run.driver === "orchestrator"
}

export const TENANT_ROW_ID = "tenant" as const

/**
 * The media type of a committed call result that carries tool requests
 * (ADR-0188 B3, REC-03).
 *
 * A call's committed output is one encrypted artifact. When the model ended on
 * a tool request the artifact holds `{ text, tool_calls }` under this type
 * instead of bare text, so a replayed step returns the same requests the first
 * attempt got — a resumed panel would otherwise see a tool round with no calls
 * and throw its candidate away. Plain `text/plain` results, written before this
 * and by every call that asked for nothing, are read exactly as before: the
 * media type, not a migration, says which one it is.
 */
export const CALL_RESULT_WITH_TOOLS_MEDIA_TYPE = "application/vnd.cognia.fusion-call-result+json"

/** The stored envelope of a committed call that ended on tool requests. */
interface CommittedCallEnvelope {
  text: string
  tool_calls: ToolIntent[]
}

export function encodeCommittedCallResult(result: CommittedCallResult): {
  content: string
  mediaType: string
} {
  if (!result.toolCalls || result.toolCalls.length === 0) {
    return { content: result.text, mediaType: "text/plain" }
  }
  const envelope: CommittedCallEnvelope = { text: result.text, tool_calls: result.toolCalls }
  return { content: JSON.stringify(envelope), mediaType: CALL_RESULT_WITH_TOOLS_MEDIA_TYPE }
}

/**
 * The text and the tool requests back out of a stored result. A stored
 * envelope that no longer parses, or whose tool calls are not the shape the
 * workflow expects, is read as text with no requests: the step is still
 * committed and is never sent again, and the workflow refuses a tool-call
 * answer that carries no calls.
 */
export function decodeCommittedCallResult(
  content: string,
  mediaType: string
): { text: string; toolCalls?: ToolIntent[] } {
  if (mediaType !== CALL_RESULT_WITH_TOOLS_MEDIA_TYPE) return { text: content }
  try {
    const parsed = JSON.parse(content) as Partial<CommittedCallEnvelope>
    const calls = Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls.filter(
          (call): call is ToolIntent =>
            typeof call?.id === "string" &&
            typeof call.name === "string" &&
            typeof call.arguments === "object" &&
            call.arguments !== null
        )
      : []
    const text = typeof parsed.text === "string" ? parsed.text : ""
    return calls.length > 0 ? { text, toolCalls: calls } : { text }
  } catch {
    return { text: "" }
  }
}

/** Stored in place of free text that is not a machine code. */
export const WITHHELD_TEXT = "withheld"
const MACHINE_CODE = /^[A-Za-z0-9_.:-]{1,80}$/

/**
 * These rows are not encrypted, and an error message from a provider, the SDK
 * or the sidecar can quote the prompt or the model's output (a JSON parse error
 * echoes the chunk it choked on). Only machine codes are persisted; any other
 * text is withheld. The code still says what happened, and nothing renders the
 * stored message.
 */
export function persistableText(text: string): string {
  return MACHINE_CODE.test(text) ? text : WITHHELD_TEXT
}

export interface FusionStoreDeps {
  db: FusionDB
  codec: FusionContentCodec
  now?: () => number
  newId?: () => string
}

export interface CreateRunInput {
  runId: string
  sessionId: string | null
  surface: RouterFusionSurface
  origin: FusionRunOrigin
  decision: RouteDecision
  actionId: string
  ruleId: string | null
  roleDeployments: Record<string, string>
  config: CompiledFusionConfig
  capMicrousd: number
  maxModelCalls: number
  deadlineMs: number
  budgetMode: "tracked" | "strict"
  /** Remaining allowance of the tightest cost-budget scope; null = no limit (D22). */
  tenantLimitRemainingMicrousd: number | null
  grantMicrousd?: number
  /** API-03: the caller's view of the session version, checked against `currentSessionVersion`. */
  expectedSessionVersion?: number
  currentSessionVersion?: number
  /** The gateway key this run belongs to; null (the default) for the app's own runs. */
  actorKeyId?: string | null
  /** That key's display name at creation time, for the cockpit row to name. */
  actorKeyName?: string | null
  /** Title for a run that has no local engine run of its own to take one from. */
  title?: string | null
  /** The artifact holding the run's input messages, for a worker that restarts it. */
  inputArtifactId?: string | null
  /** The run appends its input and its answer to its session (see `FusionRunRow`). */
  writesSessionTranscript?: boolean
  /** The run appends only its answer (a chat fusion turn, see `FusionRunRow`). */
  writesSessionAnswer?: boolean
  task?: TaskKind
  acceptanceProfile?: VerifierProfile
  dataClass?: DataClass
  workspaceRoot?: string
  /**
   * The app project the run belongs to (`RunRequest.workspace_id`). Delegate
   * needs it: its acceptance profile and that profile's approval live on the
   * project (WP-D2).
   */
  projectId?: string
  /** The `.cognia/workspace.json` acceptance profile a delegate run verifies with. */
  acceptanceProfileId?: string
  /** See `FusionRunRow.delegateDelivery`; `patch_only` when omitted. */
  delegateDelivery?: "patch_only" | "workspace_updated"
  /** See `FusionRunRow.driver`. */
  driver?: FusionRunDriver
}

export type CreateRunRefusalCode =
  "SESSION_BUSY" | "SESSION_VERSION_CONFLICT" | "RUN_EXISTS" | BudgetRefusalCode

export type CreateRunOutcome =
  | { ok: true; run: FusionRunRow }
  | { ok: false; code: CreateRunRefusalCode; activeRunId?: string; availableMicrousd?: number }

export type LeaseOutcome =
  | { ok: true; fencingToken: number; takeover: boolean }
  | { ok: false; code: "LEASE_HELD" | "RUN_TERMINAL" | "RUN_NOT_FOUND" }

export type FinalizeStatus = "succeeded" | "failed" | "cancelled" | "expired"

export interface FinalizeInput {
  status: FinalizeStatus
  error?: FusionRunError
  resultArtifactId?: string
  /** The `RunResult` record without its answer (see `FusionRunRow.resultRecordArtifactId`). */
  resultRecordArtifactId?: string
  /** Why in-flight attempts became UNKNOWN (e.g. "turn_ended_without_usage"). */
  unknownReason?: string
  /**
   * Journal events that belong to the seal itself — the verified answer's
   * delivery — appended in the same transaction, just before the terminal
   * event (DESIGN §15.2).
   */
  events?: Array<{ type: string; payload: Record<string, unknown> }>
}

export type FinalizeOutcome =
  | { ok: true; run: FusionRunRow; alreadyTerminal: boolean }
  | { ok: false; code: "FENCED" | "RUN_NOT_FOUND" }

export type PrepareRefusal = Extract<PrepareOutcome, { kind: "refused" }>["code"]

export interface RunSummary {
  run: FusionRunRow
  decision: RouteDecision | null
  attempts: FusionCallAttemptRow[]
  reservedMicrousd: number
  uncertainMicrousd: number
}

type Refusal<C extends string> = { ok: false; code: C }

function uuid(): string {
  return globalThis.crypto.randomUUID()
}

const COMMITTED_DURING_PREPARE = Symbol("committed-during-prepare")

function refusedPrepare(code: PrepareRefusal): PrepareOutcome {
  return { kind: "refused", code }
}

function snapshotOf(row: FusionReservationRow): ReservationSnapshot {
  return { kind: row.kind, amountMicrousd: row.amountMicrousd, state: row.state }
}

export class FusionLedgerStore {
  readonly db: FusionDB
  /**
   * The content cipher this store's rows are sealed with. Exposed because the
   * delegate step journal (`db/delegate-store.ts`) seals its receipts with the
   * SAME codec `fusionArtifacts.content` uses — a second codec built from the
   * same database name would work, but two of them is one more place for the
   * vault's state to be read differently.
   */
  readonly contentCodec: FusionContentCodec
  private readonly codec: FusionContentCodec
  private readonly now: () => number
  private readonly newId: () => string
  private readonly configs = new Map<string, CompiledFusionConfig>()

  constructor(deps: FusionStoreDeps) {
    this.db = deps.db
    this.codec = deps.codec
    this.contentCodec = deps.codec
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? uuid
  }

  // ── shared transaction helpers ─────────────────────────────────────────────

  private async account(): Promise<FusionAccountRow> {
    const existing = await this.db.fusionAccount.get(TENANT_ROW_ID)
    return (
      existing ?? {
        id: TENANT_ROW_ID,
        activeHoldsMicrousd: 0,
        revokedDeployments: {},
        updatedAt: this.now(),
      }
    )
  }

  /**
   * Give tenant holds back through the planner. The tenant's limit is not
   * stored here (it is the account's cost budget), so only the holds move.
   */
  private async releaseTenantHolds(releasedMicrousd: number, now: number): Promise<void> {
    const account = await this.account()
    const tenant = applyTenantRelease(
      { limitRemainingMicrousd: null, activeHoldsMicrousd: account.activeHoldsMicrousd },
      releasedMicrousd
    )
    await this.db.fusionAccount.put({
      ...account,
      activeHoldsMicrousd: tenant.activeHoldsMicrousd,
      updatedAt: now,
    })
  }

  /** Book a ledger row once; returns false when the effect was already booked. */
  private async book(
    dedupeKey: string,
    runId: string,
    kind: FusionLedgerKind,
    amountMicrousd: number,
    attemptId: string | null = null
  ): Promise<boolean> {
    if (await this.db.fusionLedger.get(dedupeKey)) return false
    await this.db.fusionLedger.add({
      dedupeKey,
      runId,
      attemptId,
      kind,
      amountMicrousd,
      createdAt: this.now(),
    })
    return true
  }

  private async event(
    run: FusionRunRow,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    run.lastSeq += 1
    const row: FusionRunEventRow = {
      runId: run.runId,
      seq: run.lastSeq,
      type,
      payload,
      createdAt: this.now(),
    }
    await this.db.fusionRunEvents.add(row)
  }

  private async transition(run: FusionRunRow, to: RunStatus, reason?: string): Promise<void> {
    assertRunTransition(run.status, to)
    const from = run.status
    run.status = to
    await this.event(run, "phase.changed", { from, to, ...(reason ? { reason } : {}) })
  }

  private async outbox(
    run: FusionRunRow,
    effectId: string,
    kind: FusionOutboxKind,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (await this.db.fusionOutbox.get(effectId)) return
    await this.db.fusionOutbox.add({
      effectId,
      runId: run.runId,
      kind,
      payload,
      status: "pending",
      attempts: 0,
      lastError: null,
      createdAt: this.now(),
      appliedAt: null,
    })
  }

  /**
   * Keep the account database's execution run in step with a fusion run that no
   * local engine started (ADR-0188 D39).
   *
   * `execution_run_milestone` annotates a run some engine already owns. This is
   * the other half: for a run that arrived over the external Run API there is
   * no chat turn, workflow or team run behind it, so without this the cockpit,
   * Squad and mobile — all of which read the account database — cannot show it
   * at all. The effect is queued INSIDE the ledger transaction like every other
   * cross-database effect, so a crash between the two databases replays it
   * rather than losing the run.
   */
  private async projectExecutionRun(
    run: FusionRunRow,
    phase: "queued" | "running" | "terminal",
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    const origin = projectedOriginOf(run)
    if (!origin) return
    await this.outbox(run, `projection:${run.runId}:${phase}`, "execution_run_projection", {
      runId: run.runId,
      phase,
      origin,
      title: run.title,
      sessionId: run.sessionId,
      actorKeyId: run.actorKeyId,
      actorKeyName: run.actorKeyName,
      mode: run.mode,
      actionId: run.actionId,
      createdAt: run.createdAt,
      ...extra,
    })
  }

  /**
   * Show the person the decision their run is waiting on, wherever they are
   * (ADR-0188 B4, D21).
   *
   * A parked delegate run is useless if the only place the request appears is
   * an API snapshot: the cockpit renders `approve` / `deny` from a PENDING
   * INTERRUPT on the execution run, so parking queues one. It travels on the
   * same `execution_run_projection` effect as the run's own phases — it IS the
   * run advancing — with the approval's id as the interrupt's, so the id the
   * surface sends back names exactly the digest that was approved (API-08).
   *
   * A run whose execution run belongs to another engine is skipped rather than
   * failed: its own surface owns the gate. Delegate only reaches here from the
   * Run API and the companion, both of which project.
   */
  private async projectRunInterrupt(
    run: FusionRunRow,
    approval: {
      approvalId: string
      requestDigest: string
      kind: string
      revision: string
      logicalStepId: string
      summary: Record<string, unknown>
    }
  ): Promise<void> {
    const origin = projectedOriginOf(run)
    if (!origin) return
    await this.outbox(
      run,
      `projection:${run.runId}:waiting:${approval.approvalId}`,
      "execution_run_projection",
      {
        runId: run.runId,
        phase: "waiting",
        origin,
        title: run.title,
        sessionId: run.sessionId,
        actorKeyId: run.actorKeyId,
        actorKeyName: run.actorKeyName,
        mode: run.mode,
        actionId: run.actionId,
        createdAt: run.createdAt,
        interrupt: {
          id: approval.approvalId,
          type: "fusion_approval",
          requestDigest: approval.requestDigest,
          kind: approval.kind,
          revision: approval.revision,
          logicalStepId: approval.logicalStepId,
          summary: approval.summary,
          expiresAt: run.deadlineAt,
        },
      }
    )
  }

  private async billingEvent(run: FusionRunRow): Promise<void> {
    await this.event(run, "billing.updated", {
      spent_microusd: run.budget.spentMicrousd,
      reserved_microusd: run.budget.activeReservationsMicrousd,
      overspend_microusd: run.budget.overspendMicrousd,
      frozen: run.budget.frozen,
      model_calls: run.budget.modelCalls,
      cost_status: run.costStatus,
    })
  }

  private async saveRun(run: FusionRunRow): Promise<void> {
    run.updatedAt = this.now()
    await this.db.fusionRuns.put(run)
  }

  private async loadConfig(digest: string): Promise<CompiledFusionConfig> {
    const cached = this.configs.get(digest)
    if (cached) return cached
    const row = await this.db.fusionConfigSnapshots.get(digest)
    if (!row) throw new Error(`Router + Fusion config snapshot ${digest} is missing`)
    this.configs.set(digest, row.config)
    return row.config
  }

  // ── tenant ─────────────────────────────────────────────────────────────────

  async getAccount(): Promise<FusionAccountRow> {
    return this.account()
  }

  /** Replace the set of deployments whose data permission is currently revoked (AUTH-07). */
  async setRevokedDeployments(deploymentIds: readonly string[]): Promise<void> {
    await this.db.transaction("rw", this.db.fusionAccount, async () => {
      const account = await this.account()
      const next: Record<string, number> = {}
      for (const id of deploymentIds) next[id] = account.revokedDeployments[id] ?? this.now()
      await this.db.fusionAccount.put({
        ...account,
        revokedDeployments: next,
        updatedAt: this.now(),
      })
    })
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  async createRun(input: CreateRunInput): Promise<CreateRunOutcome> {
    const db = this.db
    return db.transaction(
      "rw",
      [
        db.fusionAccount,
        db.fusionRuns,
        db.fusionRunEvents,
        db.fusionSessionLocks,
        db.fusionRouteDecisions,
        db.fusionConfigSnapshots,
        db.fusionLedger,
        db.fusionOutbox,
      ],
      async (): Promise<CreateRunOutcome> => {
        if (await db.fusionRuns.get(input.runId)) return { ok: false, code: "RUN_EXISTS" }
        if (
          input.expectedSessionVersion !== undefined &&
          input.currentSessionVersion !== undefined &&
          input.expectedSessionVersion !== input.currentSessionVersion
        ) {
          return { ok: false, code: "SESSION_VERSION_CONFLICT" }
        }
        if (input.sessionId) {
          const lock = await db.fusionSessionLocks.get(input.sessionId)
          if (lock) {
            const holder = await db.fusionRuns.get(lock.runId)
            if (holder && !isTerminalRunStatus(holder.status)) {
              return { ok: false, code: "SESSION_BUSY", activeRunId: holder.runId }
            }
          }
          // The previous run has ended but its transcript is not in the session
          // yet: a new run now would read a stale version and land out of order.
          const unwritten = await this.pendingTranscriptRun(input.sessionId)
          if (unwritten) return { ok: false, code: "SESSION_BUSY", activeRunId: unwritten }
        }
        const account = await this.account()
        const plan = planRunCreation(
          {
            limitRemainingMicrousd: input.tenantLimitRemainingMicrousd,
            activeHoldsMicrousd: account.activeHoldsMicrousd,
          },
          {
            capMicrousd: input.capMicrousd,
            maxModelCalls: input.maxModelCalls,
            grantMicrousd: input.grantMicrousd,
          }
        )
        if (!plan.ok) {
          return { ok: false, code: plan.code, availableMicrousd: plan.availableMicrousd }
        }
        const action = input.config.actions[input.actionId]
        if (!action) {
          throw new Error(
            `Router + Fusion action ${input.actionId} is not in config ${input.config.digest}`
          )
        }
        const now = this.now()
        if (!(await db.fusionConfigSnapshots.get(input.config.digest))) {
          await db.fusionConfigSnapshots.add({
            digest: input.config.digest,
            config: input.config,
            createdAt: now,
          })
        }
        this.configs.set(input.config.digest, input.config)
        const run: FusionRunRow = {
          runId: input.runId,
          sessionId: input.sessionId,
          surface: input.surface,
          origin: input.origin,
          mode: action.config.mode,
          actionId: input.actionId,
          actionHash: action.actionHash,
          ruleId: input.ruleId,
          decisionId: input.decision.decision_id,
          configDigest: input.config.digest,
          status: "queued",
          budget: plan.run,
          budgetMode: input.budgetMode,
          grantMicrousd: input.grantMicrousd ?? 0,
          roleDeployments: { ...input.roleDeployments },
          deadlineAt: now + input.deadlineMs,
          leaseOwner: null,
          leaseExpiresAt: 0,
          fencingToken: 0,
          lastSeq: 0,
          costStatus: "actual",
          inputArtifactId: input.inputArtifactId ?? null,
          resultArtifactId: null,
          error: null,
          sessionVersion: input.currentSessionVersion ?? null,
          actorKeyId: input.actorKeyId ?? null,
          actorKeyName: input.actorKeyName ?? null,
          title: input.title ?? null,
          ...(input.writesSessionTranscript ? { writesSessionTranscript: true } : {}),
          ...(input.writesSessionAnswer ? { writesSessionAnswer: true } : {}),
          ...(input.task ? { task: input.task } : {}),
          ...(input.acceptanceProfile ? { acceptanceProfile: input.acceptanceProfile } : {}),
          ...(input.dataClass ? { dataClass: input.dataClass } : {}),
          ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.acceptanceProfileId ? { acceptanceProfileId: input.acceptanceProfileId } : {}),
          ...(input.delegateDelivery ? { delegateDelivery: input.delegateDelivery } : {}),
          ...(input.driver ? { driver: input.driver } : {}),
          createdAt: now,
          updatedAt: now,
          terminalAt: null,
        }
        await db.fusionAccount.put({
          ...account,
          activeHoldsMicrousd: plan.tenant.activeHoldsMicrousd,
          updatedAt: now,
        })
        await this.book(`run_hold:${run.runId}`, run.runId, "run_hold", input.capMicrousd)
        if (input.grantMicrousd) {
          await this.book(`grant:${run.runId}`, run.runId, "grant", input.grantMicrousd)
        }
        await db.fusionRouteDecisions.put({
          decisionId: input.decision.decision_id,
          runId: run.runId,
          decision: input.decision,
          createdAt: now,
        })
        if (input.sessionId) {
          await db.fusionSessionLocks.put({
            sessionId: input.sessionId,
            runId: run.runId,
            acquiredAt: now,
          })
        }
        await this.event(run, "run.queued", {
          surface: run.surface,
          origin: run.origin,
          cap_microusd: run.budget.capMicrousd,
          max_model_calls: run.budget.maxModelCalls,
          deadline_at: run.deadlineAt,
        })
        await this.event(run, "route.selected", {
          decision_id: run.decisionId,
          action_id: run.actionId,
          mode: run.mode,
          rule_id: run.ruleId,
          roles: run.roleDeployments,
        })
        await this.projectExecutionRun(run, "queued")
        if (run.writesSessionTranscript && run.sessionId && run.inputArtifactId) {
          await this.outbox(run, `session:${run.runId}:input`, "session_message", {
            phase: "input",
            runId: run.runId,
            sessionId: run.sessionId,
            inputArtifactId: run.inputArtifactId,
            actorKeyName: run.actorKeyName,
          })
        }
        await db.fusionRuns.put(run)
        return { ok: true, run }
      }
    )
  }

  async getRun(runId: string): Promise<FusionRunRow | undefined> {
    return this.db.fusionRuns.get(runId)
  }

  /**
   * Take (or renew) the run lease. A live lease held by another owner refuses;
   * an expired one is taken over and the fencing token moves, so every write
   * the previous owner still has in flight is rejected (REC-02).
   */
  async acquireLease(runId: string, owner: string, leaseMs: number): Promise<LeaseOutcome> {
    return this.db.transaction(
      "rw",
      [this.db.fusionRuns, this.db.fusionRunEvents],
      async (): Promise<LeaseOutcome> => {
        const run = await this.db.fusionRuns.get(runId)
        if (!run) return { ok: false, code: "RUN_NOT_FOUND" }
        if (isTerminalRunStatus(run.status)) return { ok: false, code: "RUN_TERMINAL" }
        const now = this.now()
        if (run.leaseOwner === owner && run.leaseExpiresAt > now) {
          run.leaseExpiresAt = now + leaseMs
          await this.saveRun(run)
          return { ok: true, fencingToken: run.fencingToken, takeover: false }
        }
        if (run.leaseOwner && run.leaseOwner !== owner && run.leaseExpiresAt > now) {
          return { ok: false, code: "LEASE_HELD" }
        }
        const takeover = run.leaseOwner !== null
        run.leaseOwner = owner
        run.leaseExpiresAt = now + leaseMs
        run.fencingToken += 1
        await this.saveRun(run)
        return { ok: true, fencingToken: run.fencingToken, takeover }
      }
    )
  }

  /** queued → running under the caller's lease. */
  async startRun(
    runId: string,
    fencingToken: number
  ): Promise<
    { ok: true; run: FusionRunRow } | Refusal<"FENCED" | "RUN_NOT_FOUND" | "RUN_NOT_QUEUED">
  > {
    return this.db.transaction(
      "rw",
      [this.db.fusionRuns, this.db.fusionRunEvents, this.db.fusionOutbox],
      async () => {
        const run = await this.db.fusionRuns.get(runId)
        if (!run) return { ok: false as const, code: "RUN_NOT_FOUND" as const }
        if (run.fencingToken !== fencingToken)
          return { ok: false as const, code: "FENCED" as const }
        if (run.status !== "queued") return { ok: false as const, code: "RUN_NOT_QUEUED" as const }
        await this.transition(run, "running")
        await this.projectExecutionRun(run, "running")
        await this.saveRun(run)
        return { ok: true as const, run }
      }
    )
  }

  /**
   * running → waiting_for_input / waiting_for_approval.
   *
   * The moment is recorded (`pausedAt`), because the deadline bounds the WORK
   * a run may do and a person's deciding time is not work: `resumeRun` gives
   * back exactly the wall time spent here and no more.
   *
   * `extra` carries what the surface needs to show the wait — the approval the
   * run is parked on — so the projection and the run's journal describe the
   * same thing.
   */
  async pauseRun(
    runId: string,
    fencingToken: number,
    to: "waiting_for_input" | "waiting_for_approval",
    extra: {
      /** The approval the run is parked on (its id doubles as the interrupt's). */
      approval?: {
        approvalId: string
        requestDigest: string
        kind: string
        revision: string
        logicalStepId: string
        summary: Record<string, unknown>
      }
    } = {}
  ): Promise<{ ok: true } | Refusal<"FENCED" | "RUN_NOT_FOUND" | "ILLEGAL_TRANSITION">> {
    const db = this.db
    return db.transaction("rw", [db.fusionRuns, db.fusionRunEvents, db.fusionOutbox], async () => {
      const run = await db.fusionRuns.get(runId)
      if (!run) return { ok: false as const, code: "RUN_NOT_FOUND" as const }
      if (run.fencingToken !== fencingToken) return { ok: false as const, code: "FENCED" as const }
      if (!canTransitionRun(run.status, to)) {
        return { ok: false as const, code: "ILLEGAL_TRANSITION" as const }
      }
      run.pausedAt = this.now()
      await this.transition(run, to)
      if (extra.approval) {
        await this.event(run, "approval.requested", {
          approval_id: extra.approval.approvalId,
          request_digest: extra.approval.requestDigest,
          kind: extra.approval.kind,
          revision: extra.approval.revision,
          logical_step_id: extra.approval.logicalStepId,
          summary: extra.approval.summary,
        })
        await this.projectRunInterrupt(run, extra.approval)
      }
      await this.saveRun(run)
      return { ok: true as const }
    })
  }

  /**
   * running → reconciling: a side effect was dispatched and nobody can say
   * whether it happened (REC-06).
   *
   * Deliberately NOT a failed seal. A seal would release the money and tell
   * the caller the run did nothing, while a patch may be on disk and an
   * acceptance command may have run. `reconciling` keeps the run's money held
   * and its trail intact, and hands the question to a person through a
   * `human_handoff` interrupt. Nothing re-runs the step, ever.
   */
  async reconcileRun(
    runId: string,
    fencingToken: number,
    detail: { code: string; logicalStepId: string | null; sideEffect: string | null }
  ): Promise<{ ok: true } | Refusal<"FENCED" | "RUN_NOT_FOUND" | "ILLEGAL_TRANSITION">> {
    const db = this.db
    return db.transaction("rw", [db.fusionRuns, db.fusionRunEvents, db.fusionOutbox], async () => {
      const run = await db.fusionRuns.get(runId)
      if (!run) return { ok: false as const, code: "RUN_NOT_FOUND" as const }
      if (run.fencingToken !== fencingToken) return { ok: false as const, code: "FENCED" as const }
      if (!canTransitionRun(run.status, "reconciling")) {
        return { ok: false as const, code: "ILLEGAL_TRANSITION" as const }
      }
      await this.transition(run, "reconciling", detail.code)
      await this.event(run, "reconciliation.required", {
        code: detail.code,
        ...(detail.logicalStepId ? { logical_step_id: detail.logicalStepId } : {}),
        ...(detail.sideEffect ? { side_effect: detail.sideEffect } : {}),
      })
      const origin = projectedOriginOf(run)
      if (origin) {
        await this.outbox(
          run,
          `projection:${run.runId}:handoff:${detail.logicalStepId ?? detail.code}`,
          "execution_run_projection",
          {
            runId: run.runId,
            phase: "waiting",
            origin,
            title: run.title,
            sessionId: run.sessionId,
            actorKeyId: run.actorKeyId,
            actorKeyName: run.actorKeyName,
            mode: run.mode,
            actionId: run.actionId,
            createdAt: run.createdAt,
            interrupt: {
              id: uuidFromName(
                `${run.runId}\u0000handoff\u0000${detail.logicalStepId ?? detail.code}`
              ),
              type: "human_handoff",
              kind: detail.code,
              revision: "",
              logicalStepId: detail.logicalStepId ?? "",
              summary: { side_effect: detail.sideEffect ?? null },
              expiresAt: run.deadlineAt,
            },
          }
        )
      }
      await this.saveRun(run)
      return { ok: true as const }
    })
  }

  /**
   * Resume a waiting run (API-07 / REC-05). A run that is not waiting refuses
   * with 409 semantics; the absolute deadline is never moved.
   */
  /**
   * Continue a waiting run. With `kind`, the resume must match what the run is
   * waiting for (input vs approval) and, with `expectedVersion`, the caller
   * must have seen the run's latest event (API-08): a stale resume is a
   * conflict, not a guess. Input that arrives with the resume replaces the
   * run's stored input in the same transaction.
   */
  async resumeRun(
    runId: string,
    options: {
      kind?: "input" | "approval"
      expectedVersion?: number
      inputArtifactId?: string
    } = {}
  ): Promise<
    | { ok: true; run: FusionRunRow }
    | Refusal<"RUN_NOT_FOUND" | "RUN_NOT_WAITING" | "DEADLINE_EXCEEDED" | "RUN_VERSION_CONFLICT">
  > {
    return this.db.transaction("rw", [this.db.fusionRuns, this.db.fusionRunEvents], async () => {
      const run = await this.db.fusionRuns.get(runId)
      if (!run) return { ok: false as const, code: "RUN_NOT_FOUND" as const }
      if (options.expectedVersion !== undefined && options.expectedVersion !== run.lastSeq) {
        return { ok: false as const, code: "RUN_VERSION_CONFLICT" as const }
      }
      const waitingFor =
        run.status === "waiting_for_input"
          ? "input"
          : run.status === "waiting_for_approval"
            ? "approval"
            : null
      if (!waitingFor || (options.kind && options.kind !== waitingFor)) {
        return { ok: false as const, code: "RUN_NOT_WAITING" as const }
      }
      // Give back exactly the wall time the run spent parked, before the
      // deadline is checked.
      //
      // The deadline bounds the WORK a run may do (D29); waiting on a person
      // is not work. Without this, a run approved an hour later would fail
      // here, or — worse — pass this check and then fail inside
      // `performDurableCall`, which re-reads `deadlineAt` before it REPLAYS a
      // committed step, so a resumed run would throw away steps that already
      // happened. REC-05's "resume never moves the deadline" still holds for
      // what it was written about: nothing here extends the budget for work,
      // and a run cannot gain time by parking.
      const resumedAt = this.now()
      if (typeof run.pausedAt === "number" && run.pausedAt > 0 && resumedAt > run.pausedAt) {
        run.deadlineAt += resumedAt - run.pausedAt
      }
      run.pausedAt = null
      if (resumedAt >= run.deadlineAt) {
        return { ok: false as const, code: "DEADLINE_EXCEEDED" as const }
      }
      if (options.inputArtifactId) run.inputArtifactId = options.inputArtifactId
      await this.transition(run, "queued", "resumed")
      await this.saveRun(run)
      return { ok: true as const, run }
    })
  }

  /**
   * Ask a run to stop. A running run moves to `cancelling` (the worker finishes
   * with `finalizeRun({status:"cancelled"})`); a run with nothing executing is
   * cancelled on the spot. Terminal runs are left as they are.
   */
  async cancelRun(runId: string): Promise<FusionRunRow | undefined> {
    const db = this.db
    const cancelledNow = await db.transaction(
      "rw",
      [db.fusionRuns, db.fusionRunEvents],
      async () => {
        const run = await db.fusionRuns.get(runId)
        if (!run || isTerminalRunStatus(run.status) || run.status === "cancelling") {
          return { run, finalizeNow: false }
        }
        if (run.status === "running" || run.status === "reconciling") {
          await this.transition(run, "cancelling", "cancel_requested")
          await this.saveRun(run)
          return { run, finalizeNow: false }
        }
        return { run, finalizeNow: true }
      }
    )
    if (!cancelledNow.finalizeNow || !cancelledNow.run) return cancelledNow.run
    const outcome = await this.finalizeRun(runId, cancelledNow.run.fencingToken, {
      status: "cancelled",
    })
    return outcome.ok ? outcome.run : cancelledNow.run
  }

  /**
   * Seal a run exactly once. Whatever is still in flight is resolved in the same
   * transaction: PREPARED attempts are abandoned (never sent), DISPATCHED ones
   * become UNKNOWN (sent, no answer — money stays held), held stages are
   * released. The tenant hold goes back except what uncertain calls pin, the
   * session lock is released, and the projection is queued in the outbox.
   *
   * A concurrent finalize/cancel that lost the race finds the run terminal and
   * returns it unchanged (REC-04).
   */
  async finalizeRun(
    runId: string,
    fencingToken: number,
    input: FinalizeInput
  ): Promise<FinalizeOutcome> {
    const db = this.db
    return db.transaction(
      "rw",
      [
        db.fusionAccount,
        db.fusionRuns,
        db.fusionRunEvents,
        db.fusionSessionLocks,
        db.fusionReservations,
        db.fusionCallAttempts,
        db.fusionLedger,
        db.fusionOutbox,
      ],
      async (): Promise<FinalizeOutcome> => {
        const run = await db.fusionRuns.get(runId)
        if (!run) return { ok: false, code: "RUN_NOT_FOUND" }
        if (isTerminalRunStatus(run.status)) return { ok: true, run, alreadyTerminal: true }
        if (run.fencingToken !== fencingToken) return { ok: false, code: "FENCED" }
        const now = this.now()

        const attempts = await db.fusionCallAttempts.where("runId").equals(runId).toArray()
        for (const attempt of attempts) {
          const reservation = await db.fusionReservations.get(attempt.reservationId)
          if (!reservation) continue
          if (attempt.state === "PREPARED") {
            const plan = planReleaseReservation(run.budget, snapshotOf(reservation), {
              returnModelCall: true,
            })
            if (plan.ok) {
              run.budget = plan.next
              await db.fusionReservations.put({
                ...reservation,
                state: plan.reservation.state,
                updatedAt: now,
              })
            }
            await db.fusionCallAttempts.put({ ...attempt, state: "ABANDONED", settledAt: now })
            await this.book(`abandon:${attempt.attemptId}`, runId, "abandon", 0, attempt.attemptId)
          } else if (attempt.state === "DISPATCHED") {
            const plan = planMarkUncertain(snapshotOf(reservation))
            if (plan.ok) {
              await db.fusionReservations.put({
                ...reservation,
                state: plan.reservation.state,
                updatedAt: now,
              })
            }
            await db.fusionCallAttempts.put({
              ...attempt,
              state: "UNKNOWN",
              unknownReason: persistableText(input.unknownReason ?? "run_finalized_before_answer"),
            })
            await this.book(
              `unknown:${attempt.attemptId}`,
              runId,
              "unknown",
              reservation.amountMicrousd,
              attempt.attemptId
            )
            run.costStatus = "pending"
          }
        }
        const stages = await db.fusionReservations
          .where("[runId+state]")
          .equals([runId, "held"])
          .toArray()
        for (const stage of stages) {
          if (stage.kind !== "stage") continue
          const plan = planReleaseReservation(run.budget, snapshotOf(stage), {
            returnModelCall: false,
          })
          if (!plan.ok) continue
          run.budget = plan.next
          await db.fusionReservations.put({
            ...stage,
            state: plan.reservation.state,
            updatedAt: now,
          })
          await this.book(`release:${stage.reservationId}`, runId, "release", stage.amountMicrousd)
        }

        const uncertain = (
          await db.fusionReservations.where("[runId+state]").equals([runId, "uncertain"]).toArray()
        ).reduce((sum, r) => sum + r.amountMicrousd, 0)

        // Status: an outcome that the run cannot honestly claim is downgraded,
        // never upgraded — a run with an unknown call did not succeed cleanly.
        let target: RunStatus = input.status
        if (target === "succeeded" && uncertain > 0) target = "failed"
        if (run.status === "cancelling") target = "cancelled"
        if (target === "cancelled" && run.status === "running") {
          await this.transition(run, "cancelling", "cancel_requested")
        }
        if (!canTransitionRun(run.status, target)) {
          // e.g. queued → succeeded: the run never ran, so it failed.
          target = canTransitionRun(run.status, "failed") ? "failed" : "cancelled"
        }
        // The verified answer is named before anything says the run succeeded,
        // and only when it did: a reader that stops at the first terminal
        // signal has already seen every byte range (SSE-02).
        if (target === "succeeded") {
          for (const event of input.events ?? []) await this.event(run, event.type, event.payload)
        }
        await this.transition(run, target)

        const released = planTerminalRelease(run.budget, uncertain)
        run.budget = released.next
        await this.releaseTenantHolds(released.releasedMicrousd, now)
        await this.book(
          `terminal_release:${runId}`,
          runId,
          "terminal_release",
          released.releasedMicrousd
        )
        if (run.sessionId) {
          const lock = await db.fusionSessionLocks.get(run.sessionId)
          if (lock?.runId === runId) await db.fusionSessionLocks.delete(run.sessionId)
        }
        if (input.error) {
          run.error = {
            code: persistableText(input.error.code),
            message: persistableText(input.error.message),
          }
        } else if (target === "failed" && input.status === "succeeded" && uncertain > 0) {
          run.error = {
            code: "CALL_OUTCOME_UNKNOWN",
            message: "A model call was sent but its outcome and bill are unknown.",
          }
        }
        if (input.resultArtifactId) run.resultArtifactId = input.resultArtifactId
        if (input.resultRecordArtifactId) run.resultRecordArtifactId = input.resultRecordArtifactId
        run.terminalAt = now
        run.leaseOwner = null
        await this.billingEvent(run)
        const terminalEvent =
          target === "succeeded"
            ? "run.completed"
            : target === "cancelled"
              ? "run.cancelled"
              : target === "expired"
                ? "run.expired"
                : "run.failed"
        await this.event(run, terminalEvent, {
          status: target,
          ...(run.error ? { error_code: run.error.code } : {}),
          ...(run.resultArtifactId ? { result_artifact_id: run.resultArtifactId } : {}),
        })
        await this.outbox(run, `milestone:${runId}:terminal`, "execution_run_milestone", {
          runId,
          status: target,
          actionId: run.actionId,
          mode: run.mode,
          ruleId: run.ruleId,
          spentMicrousd: run.budget.spentMicrousd,
          overspendMicrousd: run.budget.overspendMicrousd,
          costStatus: run.costStatus,
          modelCalls: run.budget.modelCalls,
          ...(run.error ? { errorCode: run.error.code } : {}),
        })
        await this.projectExecutionRun(run, "terminal", {
          status: target,
          ...(run.error ? { errorCode: run.error.code } : {}),
        })
        if (run.writesSessionTranscript && run.sessionId) {
          // Spec §12.1: a success appends the approved answer; anything else
          // keeps the input and marks it, and never writes an answer.
          if (target === "succeeded" && run.resultArtifactId) {
            await this.outbox(run, `session:${runId}:answer`, "session_message", {
              phase: "answer",
              runId,
              sessionId: run.sessionId,
              answerArtifactId: run.resultArtifactId,
              mode: run.mode,
            })
          } else if (run.inputArtifactId) {
            await this.outbox(run, `session:${runId}:marker`, "session_message", {
              phase: "marker",
              runId,
              sessionId: run.sessionId,
              inputArtifactId: run.inputArtifactId,
              actorKeyName: run.actorKeyName,
              status: target,
              ...(run.error ? { errorCode: run.error.code } : {}),
            })
          }
        }
        if (
          run.writesSessionAnswer &&
          run.sessionId &&
          target === "succeeded" &&
          run.resultArtifactId
        ) {
          // The summary is read after every event above, so the card shows the
          // run as it ended.
          const events = await db.fusionRunEvents.where("runId").equals(runId).toArray()
          await this.outbox(run, `session:${runId}:answer`, "session_message", {
            phase: "answer",
            origin: "chat",
            runId,
            sessionId: run.sessionId,
            answerArtifactId: run.resultArtifactId,
            mode: run.mode,
            summary: fusionRunSummaryOf(run, events),
          })
        }
        await this.saveRun(run)
        return { ok: true, run, alreadyTerminal: false }
      }
    )
  }

  // ── calls ──────────────────────────────────────────────────────────────────

  async prepareCall(
    runId: string,
    fencingToken: number,
    input: PrepareCallInput
  ): Promise<PrepareOutcome> {
    const outcome = await this.prepareCallOnce(runId, fencingToken, input)
    // The step committed between the replay pre-read and the transaction: read
    // the committed result now that the transaction is closed.
    if (outcome === COMMITTED_DURING_PREPARE) {
      const replay = await this.committedResultFor(runId, input.logicalStepId)
      return replay ? { kind: "replay", result: replay } : refusedPrepare("ATTEMPTS_EXHAUSTED")
    }
    return outcome
  }

  private async prepareCallOnce(
    runId: string,
    fencingToken: number,
    input: PrepareCallInput
  ): Promise<PrepareOutcome | typeof COMMITTED_DURING_PREPARE> {
    const replay = await this.committedResultFor(runId, input.logicalStepId)
    if (replay) return { kind: "replay", result: replay }
    const run0 = await this.db.fusionRuns.get(runId)
    if (!run0) return refusedPrepare("RUN_NOT_RUNNING")
    const config = await this.loadConfig(run0.configDigest)
    const transportAttempts =
      config.actions[run0.actionId]?.extension.limits.transport_attempts_per_call ?? 1

    const db = this.db
    return db.transaction(
      "rw",
      [
        db.fusionAccount,
        db.fusionRuns,
        db.fusionRunEvents,
        db.fusionReservations,
        db.fusionCallAttempts,
        db.fusionLedger,
      ],
      async (): Promise<PrepareOutcome | typeof COMMITTED_DURING_PREPARE> => {
        const run = await db.fusionRuns.get(runId)
        if (!run) return refusedPrepare("RUN_NOT_RUNNING")
        if (run.fencingToken !== fencingToken) return refusedPrepare("FENCED")
        if (run.status !== "running") {
          return refusedPrepare(
            isTerminalRunStatus(run.status) ? "RUN_TERMINAL" : "RUN_NOT_RUNNING"
          )
        }
        const now = this.now()
        if (now >= run.deadlineAt) return refusedPrepare("DEADLINE_EXCEEDED")
        const account = await this.account()
        if (account.revokedDeployments[input.deploymentId] !== undefined) {
          return refusedPrepare("REVOKED")
        }
        const previous = await db.fusionCallAttempts
          .where("[runId+logicalStepId]")
          .equals([runId, input.logicalStepId])
          .toArray()
        // A committed step replays instead of calling again (checked again inside
        // the transaction: the pre-read above may have raced a settle). A step
        // that committed without replayable content cannot be called again.
        if (previous.some((a) => a.state === "SUCCEEDED")) {
          return previous.some((a) => a.state === "SUCCEEDED" && a.resultArtifactId)
            ? COMMITTED_DURING_PREPARE
            : refusedPrepare("ATTEMPTS_EXHAUSTED")
        }
        // An attempt that was sent and never answered (or answered only by the
        // bill) keeps its step: sending it again would be a second charge for
        // an outcome reconciliation still owns (INV-05, REC-03).
        if (previous.some((a) => a.state === "UNKNOWN" || a.state === "RECONCILED")) {
          return refusedPrepare("STEP_OUTCOME_UNKNOWN")
        }
        const consumed = previous.filter((a) => a.state !== "ABANDONED").length
        if (consumed >= transportAttempts) return refusedPrepare("ATTEMPTS_EXHAUSTED")

        let stageRow: FusionReservationRow | undefined
        if (input.fromStageId) {
          stageRow = await db.fusionReservations
            .where("stageId")
            .equals(`${runId}:${input.fromStageId}`)
            .first()
        }
        const plan = planCallReservation(
          run.budget,
          input.reserveMicrousd,
          stageRow ? snapshotOf(stageRow) : undefined
        )
        if (!plan.ok) return refusedPrepare(plan.code)
        run.budget = plan.next
        const attemptId = this.newId()
        const reservationId = `res:${attemptId}`
        await db.fusionReservations.add({
          reservationId,
          runId,
          kind: "call",
          amountMicrousd: plan.reservation.amountMicrousd,
          state: plan.reservation.state,
          stageId: null,
          attemptId,
          createdAt: now,
          updatedAt: now,
        })
        if (stageRow && plan.stage) {
          await db.fusionReservations.put({
            ...stageRow,
            amountMicrousd: plan.stage.amountMicrousd,
            state: plan.stage.state,
            updatedAt: now,
          })
          await this.book(
            `stage_convert:${attemptId}`,
            runId,
            "stage_convert",
            stageRow.amountMicrousd - plan.stage.amountMicrousd,
            attemptId
          )
        }
        const attemptNo = previous.length + 1
        await db.fusionCallAttempts.add({
          attemptId,
          runId,
          logicalStepId: input.logicalStepId,
          attemptNo,
          role: input.role,
          deploymentId: input.deploymentId,
          state: "PREPARED",
          reservationId,
          requestHash: input.requestHash,
          fencingToken,
          resultArtifactId: null,
          resultFinishReason: null,
          providerRequestId: null,
          actualMicrousd: null,
          costStatus: null,
          errorClass: null,
          unknownReason: null,
          usage: null,
          createdAt: now,
          dispatchedAt: null,
          settledAt: null,
        })
        await this.book(
          `call_hold:${attemptId}`,
          runId,
          "call_hold",
          input.reserveMicrousd,
          attemptId
        )
        await this.saveRun(run)
        return { kind: "granted", attemptId, attemptNo }
      }
    )
  }

  /**
   * PREPARED → DISPATCHED, durably, before a byte is sent. A run that stopped
   * running in between gets its attempt abandoned (it was never sent) and the
   * caller must not send.
   */
  async markDispatched(
    attemptId: string,
    fencingToken: number
  ): Promise<{ ok: true } | Refusal<"FENCED" | "RUN_NOT_RUNNING" | "NOT_PREPARED">> {
    const db = this.db
    const outcome = await db.transaction(
      "rw",
      [db.fusionRuns, db.fusionRunEvents, db.fusionCallAttempts],
      async () => {
        const attempt = await db.fusionCallAttempts.get(attemptId)
        if (!attempt || attempt.state !== "PREPARED") {
          return { ok: false as const, code: "NOT_PREPARED" as const }
        }
        const run = await db.fusionRuns.get(attempt.runId)
        if (!run || run.fencingToken !== fencingToken) {
          return { ok: false as const, code: "FENCED" as const }
        }
        if (run.status !== "running") {
          return { ok: false as const, code: "RUN_NOT_RUNNING" as const }
        }
        assertAttemptTransition(attempt.state, "DISPATCHED")
        const now = this.now()
        await db.fusionCallAttempts.put({ ...attempt, state: "DISPATCHED", dispatchedAt: now })
        await this.event(run, "call.started", {
          attempt_id: attemptId,
          logical_step_id: attempt.logicalStepId,
          attempt_no: attempt.attemptNo,
          role: attempt.role,
          deployment_id: attempt.deploymentId,
        })
        await this.saveRun(run)
        return { ok: true as const }
      }
    )
    if (!outcome.ok && outcome.code === "RUN_NOT_RUNNING") await this.abandon(attemptId)
    return outcome
  }

  /** Recovery / refusal path: a PREPARED attempt proved never sent gives back money and slot. */
  async abandon(attemptId: string): Promise<void> {
    const db = this.db
    await db.transaction(
      "rw",
      [db.fusionRuns, db.fusionReservations, db.fusionCallAttempts, db.fusionLedger],
      async () => {
        const attempt = await db.fusionCallAttempts.get(attemptId)
        if (!attempt || attempt.state !== "PREPARED") return
        const run = await db.fusionRuns.get(attempt.runId)
        const reservation = await db.fusionReservations.get(attempt.reservationId)
        if (!run || !reservation) return
        const plan = planReleaseReservation(run.budget, snapshotOf(reservation), {
          returnModelCall: true,
        })
        const now = this.now()
        if (plan.ok) {
          run.budget = plan.next
          await db.fusionReservations.put({
            ...reservation,
            state: plan.reservation.state,
            updatedAt: now,
          })
        }
        await db.fusionCallAttempts.put({ ...attempt, state: "ABANDONED", settledAt: now })
        await this.book(`abandon:${attemptId}`, attempt.runId, "abandon", 0, attemptId)
        await this.saveRun(run)
      }
    )
  }

  /**
   * Settle what an earlier lease holder left in flight, for the worker that
   * just took the run over. An attempt written under an older fencing token
   * can no longer be dispatched by anyone (`markDispatched` fences it), so a
   * PREPARED one was never sent and gives its money and call slot back, and a
   * DISPATCHED one was sent and never answered: it turns UNKNOWN, keeps its
   * money, and its step is never sent again (REC-03).
   */
  async settleOrphanedAttempts(
    runId: string,
    fencingToken: number
  ): Promise<{ abandoned: number; unknown: number }> {
    const orphans = await this.db.fusionCallAttempts
      .where("runId")
      .equals(runId)
      .filter(
        (a) => a.fencingToken < fencingToken && (a.state === "PREPARED" || a.state === "DISPATCHED")
      )
      .toArray()
    let abandoned = 0
    let unknown = 0
    for (const attempt of orphans) {
      if (attempt.state === "PREPARED") {
        await this.abandon(attempt.attemptId)
        abandoned += 1
      } else {
        await this.markUnknown(attempt.attemptId, "worker_lost")
        unknown += 1
      }
    }
    return { abandoned, unknown }
  }

  /** Sent, no answer: keep the money held, never retry this attempt (BUD-06). */
  async markUnknown(attemptId: string, rawReason: string): Promise<void> {
    const reason = persistableText(rawReason)
    const db = this.db
    await db.transaction(
      "rw",
      [
        db.fusionRuns,
        db.fusionRunEvents,
        db.fusionReservations,
        db.fusionCallAttempts,
        db.fusionLedger,
      ],
      async () => {
        const attempt = await db.fusionCallAttempts.get(attemptId)
        if (!attempt || attempt.state !== "DISPATCHED") return
        const reservation = await db.fusionReservations.get(attempt.reservationId)
        const run = await db.fusionRuns.get(attempt.runId)
        if (!reservation || !run) return
        const plan = planMarkUncertain(snapshotOf(reservation))
        const now = this.now()
        if (plan.ok) {
          await db.fusionReservations.put({
            ...reservation,
            state: plan.reservation.state,
            updatedAt: now,
          })
        }
        await db.fusionCallAttempts.put({ ...attempt, state: "UNKNOWN", unknownReason: reason })
        await this.book(
          `unknown:${attemptId}`,
          attempt.runId,
          "unknown",
          reservation.amountMicrousd,
          attemptId
        )
        run.costStatus = "pending"
        await this.event(run, "call.finished", {
          attempt_id: attemptId,
          state: "UNKNOWN",
          reason,
          reserved_microusd: reservation.amountMicrousd,
        })
        await this.saveRun(run)
      }
    )
  }

  /**
   * Book a call's outcome. Deduplicated per attempt (BUD-03), accepted for a
   * terminal run (late usage, BUD-07) and regardless of fencing — the provider
   * bill exists no matter which worker observed it (REC-02).
   */
  async settleCall(attemptId: string, input: SettleCallInput): Promise<SettleOutcome> {
    const attempt0 = await this.db.fusionCallAttempts.get(attemptId)
    if (!attempt0) throw new Error(`Router + Fusion attempt ${attemptId} is unknown`)
    const run0 = await this.db.fusionRuns.get(attempt0.runId)
    if (!run0) throw new Error(`Router + Fusion run ${attempt0.runId} is unknown`)
    const config = await this.loadConfig(run0.configDigest)
    // Committed output is sealed before the transaction (WebCrypto would commit it).
    const committed =
      input.status === "succeeded" && input.result && attempt0.state !== "UNKNOWN"
        ? encodeCommittedCallResult(input.result)
        : null
    const resultArtifact = committed
      ? await this.artifactStore(run0.runId).put(
          committed.content,
          committed.mediaType,
          `call:${attemptId}`
        )
      : null

    const db = this.db
    return db.transaction(
      "rw",
      [
        db.fusionAccount,
        db.fusionRuns,
        db.fusionRunEvents,
        db.fusionReservations,
        db.fusionCallAttempts,
        db.fusionLedger,
        db.fusionOutbox,
      ],
      async (): Promise<SettleOutcome> => {
        const attempt = await db.fusionCallAttempts.get(attemptId)
        const run = await db.fusionRuns.get(attempt0.runId)
        if (!attempt || !run) throw new Error(`Router + Fusion attempt ${attemptId} vanished`)
        const settled = await db.fusionLedger.get(`settle:${attemptId}`)
        if (settled) {
          return {
            actualMicrousd: settled.amountMicrousd,
            frozen: run.budget.frozen,
            costStatus: attempt.costStatus ?? "actual",
          }
        }
        if (attempt.state === "PREPARED") {
          // Nothing was sent: an explicit pre-send failure frees money and slot.
          throw new Error(`Router + Fusion attempt ${attemptId} settled before dispatch`)
        }
        const reservation = await db.fusionReservations.get(attempt.reservationId)
        if (!reservation) throw new Error(`Router + Fusion reservation for ${attemptId} is missing`)
        const priced = this.price(
          config,
          attempt.deploymentId,
          reservation.amountMicrousd,
          input,
          attempt.state === "UNKNOWN"
        )
        const plan = planSettle(run.budget, snapshotOf(reservation), priced.amount)
        if (!plan.ok) throw new Error(`Router + Fusion settle refused: ${plan.code}`)
        const now = this.now()
        run.budget = plan.next
        await db.fusionReservations.put({
          ...reservation,
          state: plan.reservation.state,
          updatedAt: now,
        })
        await this.book(`settle:${attemptId}`, run.runId, "settle", priced.amount, attemptId)
        if (plan.overspendDeltaMicrousd > 0) {
          await this.book(
            `overspend:${attemptId}`,
            run.runId,
            "overspend",
            plan.overspendDeltaMicrousd,
            attemptId
          )
        }
        let releaseToTenant = plan.tenantHoldConsumedMicrousd
        if (isTerminalRunStatus(run.status)) {
          // Late usage on a sealed run: the hold it pinned beyond this bill goes back.
          const stillUncertain = (
            await db.fusionReservations
              .where("[runId+state]")
              .equals([run.runId, "uncertain"])
              .toArray()
          ).reduce((sum, r) => sum + r.amountMicrousd, 0)
          const released = planTerminalRelease(run.budget, stillUncertain)
          run.budget = released.next
          releaseToTenant += released.releasedMicrousd
          if (released.releasedMicrousd > 0) {
            await this.book(
              `terminal_release:${run.runId}:${attemptId}`,
              run.runId,
              "terminal_release",
              released.releasedMicrousd,
              attemptId
            )
          }
          if (stillUncertain === 0 && run.costStatus === "pending") run.costStatus = "actual"
        }
        await this.releaseTenantHolds(releaseToTenant, now)
        const nextState =
          attempt.state === "UNKNOWN"
            ? "RECONCILED"
            : input.status === "succeeded"
              ? "SUCCEEDED"
              : "FAILED"
        assertAttemptTransition(attempt.state, nextState)
        await db.fusionCallAttempts.put({
          ...attempt,
          state: nextState,
          actualMicrousd: priced.amount,
          costStatus: priced.status,
          providerRequestId: input.providerRequestId,
          errorClass: input.errorClass ?? priced.errorClass ?? null,
          usage: priced.usage,
          resultArtifactId: resultArtifact?.artifactId ?? attempt.resultArtifactId,
          resultFinishReason: input.result?.finishReason ?? attempt.resultFinishReason,
          settledAt: now,
        })
        if (priced.status === "estimated" && run.costStatus === "actual")
          run.costStatus = "estimated"
        await this.event(run, "call.finished", {
          attempt_id: attemptId,
          state: nextState,
          cost_microusd: priced.amount,
          cost_status: priced.status,
          ...(input.errorClass ? { error_class: input.errorClass } : {}),
        })
        await this.billingEvent(run)
        // One usage row per unit of work, one writer. A direct chat turn
        // already writes its row (keyed by the assistant message) and takes its
        // cost from this ledger; every other run gets its rows projected here.
        const deployment = config.deploymentsById[attempt.deploymentId]
        if (ledgerWritesUsageRows(run))
          await this.outbox(run, `usage:${attemptId}`, "usage_row", {
            runId: run.runId,
            attemptId,
            origin: run.origin,
            sessionId: run.sessionId,
            deploymentId: attempt.deploymentId,
            providerId: deployment?.providerId ?? null,
            modelId: deployment?.modelRevision ?? null,
            role: attempt.role,
            costMicrousd: priced.amount,
            costStatus: priced.status,
            usage: priced.usage,
            providerRequestId: input.providerRequestId,
            settledAt: now,
          })
        await this.saveRun(run)
        return {
          actualMicrousd: priced.amount,
          frozen: run.budget.frozen,
          costStatus: priced.status,
        }
      }
    )
  }

  private price(
    config: CompiledFusionConfig,
    deploymentId: string,
    reservedMicrousd: number,
    input: SettleCallInput,
    wasUnknown: boolean
  ): {
    amount: number
    status: FusionCostStatus
    usage: Record<string, unknown> | null
    errorClass?: string
  } {
    if (!input.usage || !input.semantics) {
      // An explicit provider failure without a bill produced nothing billable.
      // A call that happened (succeeded) or whose outcome was never known
      // (UNKNOWN) is booked at its conservative reservation as an estimate —
      // never as zero.
      return input.status === "failed" && !wasUnknown
        ? { amount: 0, status: "actual", usage: null }
        : { amount: reservedMicrousd, status: "estimated", usage: null }
    }
    let normalized
    try {
      normalized = normalizeUsage(input.usage, input.semantics)
    } catch (error) {
      if (!(error instanceof UsageInconsistentError)) throw error
      return {
        amount: reservedMicrousd,
        status: "estimated",
        usage: { raw: input.usage },
        errorClass: "usage_inconsistent",
      }
    }
    const deployment = config.deploymentsById[deploymentId]
    const card = deployment?.rateCardId ? config.rateCardsById[deployment.rateCardId] : undefined
    const usageRecord = normalized as unknown as Record<string, unknown>
    if (!card) return { amount: reservedMicrousd, status: "estimated", usage: usageRecord }
    try {
      const priced = priceUsage(normalized, card, config.registry.per_call_prices?.[deploymentId])
      return { amount: priced.total_microusd, status: "actual", usage: usageRecord }
    } catch {
      // An unpriced per-call item: book the tokens we can price plus the rest as estimate.
      return { amount: reservedMicrousd, status: "estimated", usage: usageRecord }
    }
  }

  async reserveStage(
    runId: string,
    fencingToken: number,
    stageId: string,
    amountMicrousd: number
  ): Promise<
    { kind: "granted" } | { kind: "refused"; code: BudgetRefusalCode | "RUN_NOT_RUNNING" }
  > {
    const db = this.db
    return db.transaction(
      "rw",
      [db.fusionRuns, db.fusionReservations, db.fusionLedger],
      async () => {
        const run = await db.fusionRuns.get(runId)
        if (!run || run.fencingToken !== fencingToken || run.status !== "running") {
          return { kind: "refused" as const, code: "RUN_NOT_RUNNING" as const }
        }
        const key = `${runId}:${stageId}`
        const existing = await db.fusionReservations.where("stageId").equals(key).first()
        if (existing) return { kind: "granted" as const }
        const plan = planStageReservation(run.budget, amountMicrousd)
        if (!plan.ok) return { kind: "refused" as const, code: plan.code }
        run.budget = plan.next
        const now = this.now()
        await db.fusionReservations.add({
          reservationId: `stage:${key}`,
          runId,
          kind: "stage",
          amountMicrousd,
          state: "held",
          stageId: key,
          attemptId: null,
          createdAt: now,
          updatedAt: now,
        })
        await this.book(`stage_hold:${key}`, runId, "stage_hold", amountMicrousd)
        await this.saveRun(run)
        return { kind: "granted" as const }
      }
    )
  }

  async releaseStage(runId: string, stageId: string): Promise<void> {
    const db = this.db
    await db.transaction(
      "rw",
      [db.fusionRuns, db.fusionReservations, db.fusionLedger],
      async () => {
        const key = `${runId}:${stageId}`
        const stage = await db.fusionReservations.where("stageId").equals(key).first()
        const run = await db.fusionRuns.get(runId)
        if (!stage || !run || stage.state !== "held") return
        const plan = planReleaseReservation(run.budget, snapshotOf(stage), {
          returnModelCall: false,
        })
        if (!plan.ok) return
        run.budget = plan.next
        await db.fusionReservations.put({
          ...stage,
          state: plan.reservation.state,
          updatedAt: this.now(),
        })
        await this.book(`release:${stage.reservationId}`, runId, "release", stage.amountMicrousd)
        await this.saveRun(run)
      }
    )
  }

  /**
   * Envelope mode (ADR-0188 D34): book a call the Claude Agent SDK already made
   * inside its own loop, observed from the stream after the fact. It cannot be
   * refused — the money is spent — so admission checks do not apply: the call
   * converts what the envelope stage still holds, the full actual cost is
   * booked, anything beyond the stage is overspend and freezes the run, and a
   * call past the model-call limit freezes it too. The next envelope check then
   * stops the SDK. Idempotent per logical step (one assistant message id).
   */
  async recordObservedCall(
    runId: string,
    input: {
      logicalStepId: string
      role: string
      deploymentId: string
      stageId: string
      status: "succeeded" | "failed"
      usage: SettleCallInput["usage"]
      semantics: SettleCallInput["semantics"]
      providerRequestId: string | null
      errorClass?: string
      /**
       * A failed request whose bill is unknowable (a transport failure after the
       * request may have been processed): booked at the conservative estimate,
       * where an explicit refusal without a bill books nothing.
       */
      outcomeUnknown?: boolean
      /** Booked as an estimate when the call carries no bill or no audited price — never zero. */
      conservativeMicrousd: number
    }
  ): Promise<{ attemptId: string; actualMicrousd: number; frozen: boolean; duplicate: boolean }> {
    const run0 = await this.db.fusionRuns.get(runId)
    if (!run0) throw new Error(`Router + Fusion run ${runId} is unknown`)
    const config = await this.loadConfig(run0.configDigest)
    const priced = this.price(
      config,
      input.deploymentId,
      input.conservativeMicrousd,
      {
        status: input.status,
        usage: input.usage,
        semantics: input.semantics,
        providerRequestId: input.providerRequestId,
      },
      input.outcomeUnknown === true
    )
    const db = this.db
    return db.transaction(
      "rw",
      [
        db.fusionAccount,
        db.fusionRuns,
        db.fusionRunEvents,
        db.fusionReservations,
        db.fusionCallAttempts,
        db.fusionLedger,
        db.fusionOutbox,
      ],
      async () => {
        const run = await db.fusionRuns.get(runId)
        if (!run) throw new Error(`Router + Fusion run ${runId} vanished`)
        const existing = await db.fusionCallAttempts
          .where("[runId+logicalStepId]")
          .equals([runId, input.logicalStepId])
          .first()
        if (existing) {
          return {
            attemptId: existing.attemptId,
            actualMicrousd: existing.actualMicrousd ?? 0,
            frozen: run.budget.frozen,
            duplicate: true,
          }
        }
        const now = this.now()
        const stage = await db.fusionReservations
          .where("stageId")
          .equals(`${runId}:${input.stageId}`)
          .first()
        const stageLeft = stage && stage.state === "held" ? stage.amountMicrousd : 0
        const covered = Math.min(priced.amount, stageLeft)
        const attemptId = this.newId()
        const reservationId = `res:${attemptId}`
        if (stage && covered > 0) {
          const left = stageLeft - covered
          await db.fusionReservations.put({
            ...stage,
            amountMicrousd: left,
            state: left > 0 ? "held" : "converted",
            updatedAt: now,
          })
          await this.book(`stage_convert:${attemptId}`, runId, "stage_convert", covered, attemptId)
        }
        run.budget = { ...run.budget, modelCalls: run.budget.modelCalls + 1 }
        const settle = planSettle(
          { ...run.budget, activeReservationsMicrousd: run.budget.activeReservationsMicrousd },
          { kind: "call", amountMicrousd: covered, state: "held" },
          priced.amount
        )
        if (!settle.ok) throw new Error(`Router + Fusion observed settle refused: ${settle.code}`)
        run.budget = {
          ...settle.next,
          frozen: settle.next.frozen || settle.next.modelCalls > settle.next.maxModelCalls,
        }
        await db.fusionReservations.add({
          reservationId,
          runId,
          kind: "call",
          amountMicrousd: covered,
          state: "settled",
          stageId: null,
          attemptId,
          createdAt: now,
          updatedAt: now,
        })
        await db.fusionCallAttempts.add({
          attemptId,
          runId,
          logicalStepId: input.logicalStepId,
          attemptNo: 1,
          role: input.role,
          deploymentId: input.deploymentId,
          state: input.status === "succeeded" ? "SUCCEEDED" : "FAILED",
          reservationId,
          requestHash: input.logicalStepId,
          fencingToken: run.fencingToken,
          resultArtifactId: null,
          resultFinishReason: null,
          providerRequestId: input.providerRequestId,
          actualMicrousd: priced.amount,
          costStatus: priced.status,
          errorClass: input.errorClass ?? priced.errorClass ?? null,
          unknownReason: null,
          usage: priced.usage,
          createdAt: now,
          dispatchedAt: now,
          settledAt: now,
        })
        await this.book(`call_hold:${attemptId}`, runId, "call_hold", covered, attemptId)
        await this.book(`settle:${attemptId}`, runId, "settle", priced.amount, attemptId)
        if (settle.overspendDeltaMicrousd > 0) {
          await this.book(
            `overspend:${attemptId}`,
            runId,
            "overspend",
            settle.overspendDeltaMicrousd,
            attemptId
          )
        }
        await this.releaseTenantHolds(settle.tenantHoldConsumedMicrousd, now)
        if (priced.status === "estimated" && run.costStatus === "actual")
          run.costStatus = "estimated"
        await this.event(run, "call.started", {
          attempt_id: attemptId,
          logical_step_id: input.logicalStepId,
          attempt_no: 1,
          role: input.role,
          deployment_id: input.deploymentId,
          observed: true,
        })
        await this.event(run, "call.finished", {
          attempt_id: attemptId,
          state: input.status === "succeeded" ? "SUCCEEDED" : "FAILED",
          cost_microusd: priced.amount,
          cost_status: priced.status,
          ...(input.errorClass ? { error_class: input.errorClass } : {}),
        })
        await this.billingEvent(run)
        await this.saveRun(run)
        return {
          attemptId,
          actualMicrousd: priced.amount,
          frozen: run.budget.frozen,
          duplicate: false,
        }
      }
    )
  }

  /**
   * Time-boxed resolution of calls that never got a bill (no usage lookup exists
   * for the provider): after `maxAgeMs` the held reservation is booked as an
   * estimated cost. Never zero — UNKNOWN is not free.
   */
  async reconcileExpiredUnknown(maxAgeMs: number): Promise<number> {
    const cutoff = this.now() - maxAgeMs
    const unknown = await this.db.fusionCallAttempts.where("state").equals("UNKNOWN").toArray()
    let reconciled = 0
    for (const attempt of unknown) {
      if ((attempt.dispatchedAt ?? attempt.createdAt) > cutoff) continue
      await this.settleCall(attempt.attemptId, {
        status: "failed",
        usage: null,
        semantics: null,
        providerRequestId: attempt.providerRequestId,
        // Sent and never answered; the time box only ends the wait for a bill.
        errorClass: "timeout_after_send",
      })
      reconciled += 1
    }
    return reconciled
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async listEvents(runId: string, afterSeq = 0): Promise<FusionRunEventRow[]> {
    return this.db.fusionRunEvents
      .where("[runId+seq]")
      .between([runId, afterSeq + 1], [runId, Number.MAX_SAFE_INTEGER], true, true)
      .toArray()
  }

  async runSummary(runId: string): Promise<RunSummary | null> {
    const run = await this.db.fusionRuns.get(runId)
    if (!run) return null
    const [decisionRow, attempts, reservations] = await Promise.all([
      this.db.fusionRouteDecisions.get(run.decisionId),
      this.db.fusionCallAttempts.where("runId").equals(runId).sortBy("createdAt"),
      this.db.fusionReservations.where("runId").equals(runId).toArray(),
    ])
    return {
      run,
      decision: decisionRow?.decision ?? null,
      attempts,
      reservedMicrousd: reservations
        .filter((r) => r.state === "held")
        .reduce((s, r) => s + r.amountMicrousd, 0),
      uncertainMicrousd: reservations
        .filter((r) => r.state === "uncertain")
        .reduce((s, r) => s + r.amountMicrousd, 0),
    }
  }

  runAvailable(run: FusionRunRow): number {
    return runAvailableMicrousd(run.budget)
  }

  private async committedResultFor(
    runId: string,
    logicalStepId: string
  ): Promise<CommittedCallResult | null> {
    const attempts = await this.db.fusionCallAttempts
      .where("[runId+logicalStepId]")
      .equals([runId, logicalStepId])
      .toArray()
    const committed = attempts.find((a) => a.state === "SUCCEEDED" && a.resultArtifactId)
    if (!committed?.resultArtifactId) return null
    const artifact = await this.artifactStore(runId).get(committed.resultArtifactId)
    if (!artifact) return null
    const stored = decodeCommittedCallResult(artifact.content, artifact.artifact.mediaType)
    return {
      text: stored.text,
      providerRequestId: committed.providerRequestId,
      finishReason: committed.resultFinishReason ?? "stop",
      ...(stored.toolCalls ? { toolCalls: stored.toolCalls } : {}),
    }
  }

  // ── artifacts ──────────────────────────────────────────────────────────────

  artifactStore(runId: string | null): ArtifactStore {
    const db = this.db
    const codec = this.codec
    const now = this.now
    return {
      async put(content, mediaType, namespace): Promise<StoredArtifact> {
        const contentSha256 = sha256Hex(content)
        // Content-addressed within its run and namespace, and a UUID as the
        // contracts require: the same text written by another run is another
        // artifact, never a shared entry (CACHE-05).
        const artifactId = uuidFromName(`${runId}\u0000${namespace}\u0000${contentSha256}`)
        const existing = await db.fusionArtifacts.get(artifactId)
        const sizeBytes = new TextEncoder().encode(content).byteLength
        if (existing) {
          return {
            artifactId,
            contentSha256,
            sizeBytes: existing.sizeBytes,
            mediaType: existing.mediaType,
          }
        }
        const sealed = await codec.seal("fusionArtifacts", artifactId, "content", content)
        const createdAt = now()
        await db.fusionArtifacts.put({
          artifactId,
          runId,
          namespace,
          mediaType,
          contentSha256,
          sizeBytes,
          content: sealed.content,
          encryptedContent: sealed.encryptedContent,
          createdAt,
          expiresAt: createdAt + ARTIFACT_CONTENT_TTL_MS,
        })
        return { artifactId, contentSha256, sizeBytes, mediaType }
      },
      async get(artifactId) {
        const row = await db.fusionArtifacts.get(artifactId)
        if (!row) return null
        const content = await codec.open("fusionArtifacts", artifactId, "content", row)
        if (sha256Hex(content) !== row.contentSha256) {
          throw new Error(`Router + Fusion artifact ${artifactId} failed its integrity check`)
        }
        return {
          content,
          artifact: {
            artifactId,
            contentSha256: row.contentSha256,
            sizeBytes: row.sizeBytes,
            mediaType: row.mediaType,
          },
        }
      },
    }
  }

  /**
   * The immutable config snapshot a run pinned when it was created. A worker
   * that picks the run up after a reload reads it from here rather than
   * recompiling: settings may have changed since, and a run's snapshot never
   * does (INV-02).
   */
  async loadRunConfig(runId: string): Promise<CompiledFusionConfig | null> {
    const run = await this.db.fusionRuns.get(runId)
    if (!run) return null
    // Null rather than a throw: a snapshot that is not there is a broken
    // database, and the caller turns it into an infrastructure fault with the
    // context of what it was trying to run.
    return this.loadConfig(run.configDigest).catch(() => null)
  }

  /**
   * Append one workflow event to a running run's journal (ADR-0188 B2).
   *
   * The journal is the single status source for an enabled run, so a graph's
   * phase and verification events go here and the SSE stream replays them by
   * seq. A fenced writer is ignored rather than refused: it is a worker whose
   * lease was taken over, and its events describe work another worker has
   * already redone. A terminal run takes no more events.
   */
  async appendWorkflowEvent(
    runId: string,
    fencingToken: number,
    type: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.db.transaction("rw", [this.db.fusionRuns, this.db.fusionRunEvents], async () => {
      const run = await this.db.fusionRuns.get(runId)
      if (!run || run.fencingToken !== fencingToken || isTerminalRunStatus(run.status)) return
      await this.event(run, type, payload)
      if (type === "phase.changed" && typeof payload.phase === "string") run.phase = payload.phase
      await this.saveRun(run)
    })
  }

  /**
   * The run whose transcript effect for this session is still waiting to be
   * applied, if any. Checked inside `createRun`'s transaction.
   */
  private async pendingTranscriptRun(sessionId: string): Promise<string | null> {
    const pending = await this.db.fusionOutbox
      .where("kind")
      .equals("session_message")
      .filter((row) => row.status === "pending" && row.payload.sessionId === sessionId)
      .first()
    return pending?.runId ?? null
  }

  /** What an outbox drain needs from this store: its artifacts, decrypted. */
  outboxContext(): { readArtifact: (artifactId: string) => Promise<string | null> } {
    const artifacts = this.artifactStore(null)
    return {
      readArtifact: async (artifactId) => (await artifacts.get(artifactId))?.content ?? null,
    }
  }

  /** The EventSink a workflow graph emits into, bound to a run and its fencing token. */
  eventSinkFor(runId: string, fencingToken: number): EventSink {
    return {
      emit: (event) => this.appendWorkflowEvent(runId, fencingToken, event.type, event.payload),
    }
  }

  /** The CallLedgerPort a workflow graph runs against, bound to a run and its fencing token. */
  ledgerFor(runId: string, fencingToken: number): CallLedgerPort {
    return {
      prepare: (input) => this.prepareCall(runId, fencingToken, input),
      markDispatched: async (attemptId) => {
        const outcome = await this.markDispatched(attemptId, fencingToken)
        if (!outcome.ok) throw new Error(`Router + Fusion dispatch refused: ${outcome.code}`)
      },
      settle: (attemptId, input) => this.settleCall(attemptId, input),
      markUnknown: (attemptId, reason) => this.markUnknown(attemptId, reason),
      abandon: (attemptId) => this.abandon(attemptId),
      reserveStage: (stageId, amount) => this.reserveStage(runId, fencingToken, stageId, amount),
      releaseStage: (stageId) => this.releaseStage(runId, stageId),
    }
  }
}
