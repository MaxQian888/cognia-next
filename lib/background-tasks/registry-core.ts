import type { SideEffectClass } from "@cognia/agent"
import type { ResolvedCaller } from "@/lib/claude/agents/dispatch-run"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import { startLeaseHeartbeat } from "@/lib/runtime/lease-heartbeat"

export type BackgroundTaskHost = "renderer" | "cli"
export type BackgroundTaskKind = "subagent" | "plugin-agent" | "team-delegation"
export type BackgroundTaskStatus = "running" | "done" | "error" | "interrupted"

/**
 * Parent-session delivery state for a settled run's result re-injection:
 * `pending` (settled, not yet deliverable), `delivered` (injected into the
 * parent chat), `notified` (surfaced via notification only), `orphaned`
 * (parent session no longer exists).
 */
export type BackgroundTaskDeliveryState = "pending" | "delivered" | "notified" | "orphaned"

export interface BackgroundTaskUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  totalCostUsd?: number
}

/** Replay proof owned by the dispatch adapter, not inferred from tool names. */
export interface BackgroundDispatchRecovery {
  version: 1
  phase: "accepted" | "dispatched"
  namespaceId: string
  hostId: string
  contextFingerprint: string
  executionSessionId: string
  caller: ResolvedCaller
  target: PluginSubagentDef
  sideEffect: SideEffectClass
}

export interface BackgroundTaskJournalRecord {
  /** Renderer execution ownership; persisted without another table or index. */
  ownerLease?: { ownerId: string; epoch: number; expiresAt: number }
  cancelRequestedAt?: number
  recovery?: BackgroundDispatchRecovery
  runId: string
  kind: BackgroundTaskKind
  subagentId: string
  prompt: string
  sessionId: string
  host: BackgroundTaskHost
  status: BackgroundTaskStatus
  startedAt: number
  settledAt?: number
  resultText?: string
  error?: string
  usage?: BackgroundTaskUsage
  // ── Optional, non-indexed extensions (no Dexie schema bump required) ──────
  /** Foreground dispatches are journaled too; absent ≡ "background" (legacy rows). */
  mode?: "foreground" | "background"
  /** Tool-loop flag of the original dispatch — needed to re-dispatch faithfully. */
  toolsEnabled?: boolean
  /** Explicit per-dispatch model override, preserved on rerun. */
  model?: string
  /** Last successful collect (results stay collectable; rows prune by age/cap). */
  collectedAt?: number
  /** Parent re-injection state for settled done|error rows. */
  deliveryId?: string
  deliveryState?: BackgroundTaskDeliveryState
  deliveredAt?: number
  /** Provenance: this row is a resume/re-run of that run. */
  resumeOfRunId?: string
  /** Set on the ORIGINAL row when a resume/re-run was dispatched from it. */
  resumedByRunId?: string
  /** Chained auto-resume attempt counter (crash-loop cap; 0/absent = fresh). */
  resumeAttempt?: number
  /** Owning plugin for plugin-agent runs (cancelByPlugin selector). */
  pluginId?: string
  /** Optional human label (plugin-agent / team-delegation rows). */
  label?: string
}

/** Journal fields mutable after start (settle + post-settle bookkeeping). */
export type BackgroundTaskJournalPatch = Partial<
  Pick<
    BackgroundTaskJournalRecord,
    | "status"
    | "settledAt"
    | "resultText"
    | "error"
    | "usage"
    | "collectedAt"
    | "deliveryId"
    | "deliveryState"
    | "deliveredAt"
    | "resumedByRunId"
    | "cancelRequestedAt"
  >
>

export interface BackgroundTaskJournalProjection {
  text: string
  error?: string
  usage?: BackgroundTaskUsage
}

export interface BackgroundTaskJournalWriter {
  renewLease?(runId: string): Promise<boolean>
  leaseIntervalMs?: number
  recordStart(record: BackgroundTaskJournalRecord): void | Promise<void>
  recordSettle(runId: string, patch: BackgroundTaskJournalPatch): void | Promise<void>
}

export interface BackgroundTaskJournal extends BackgroundTaskJournalWriter {
  list(): Promise<BackgroundTaskJournalRecord[]>
  get(runId: string): Promise<BackgroundTaskJournalRecord | undefined>
  update(runId: string, patch: BackgroundTaskJournalPatch): void | Promise<void>
  clearSettled(): void | Promise<void>
}

export type BackgroundTaskStartMeta = Omit<
  BackgroundTaskJournalRecord,
  | "runId"
  | "status"
  | "settledAt"
  | "resultText"
  | "error"
  | "usage"
  | "collectedAt"
  | "deliveryId"
  | "deliveryState"
  | "deliveredAt"
  | "resumedByRunId"
>

export interface BackgroundTaskListEntry extends BackgroundTaskJournalRecord {
  cancelled?: boolean
}

/** Terminal payload handed to {@link BackgroundTaskRegistryOptions.onSettle}. */
export interface BackgroundTaskSettleInfo {
  status: "done" | "error"
  settledAt: number
  resultText?: string
  error?: string
  usage?: BackgroundTaskUsage
}

export interface BackgroundTaskRegistryOptions<T> {
  journal?: BackgroundTaskJournalWriter
  projectForJournal: (value: T) => BackgroundTaskJournalProjection
  now?: () => number
  /** Stop local progress observers without publishing an uncommitted result. */
  onDiscard?: (runId: string) => void
  /**
   * Best-effort terminal hook fired when a tracked run settles (done | error).
   * Receives the settle payload directly — never races the async journal
   * write. A throwing listener is swallowed; the lifecycle contract holds.
   */
  onSettle?: (
    runId: string,
    meta: BackgroundTaskStartMeta,
    settle: BackgroundTaskSettleInfo
  ) => void
}

export interface BackgroundTaskControls {
  cancel?: () => void | Promise<void>
  /** Ownership loss aborts execution without trying to cancel the new owner. */
  onLeaseLost?: () => void
}

interface Entry<T> {
  promise: Promise<T>
  meta: BackgroundTaskStartMeta
  status: BackgroundTaskStatus
  settledAt?: number
  resultText?: string
  error?: string
  usage?: BackgroundTaskUsage
  controls?: BackgroundTaskControls
  cancelled?: boolean
  stopLease?: () => void
}

const INTERRUPTED_ERROR = "Background task interrupted because its host process stopped."

export class BackgroundTaskRegistry<T> {
  private readonly runs = new Map<string, Entry<T>>()
  private readonly projectForJournal: (value: T) => BackgroundTaskJournalProjection
  private readonly journal?: BackgroundTaskJournalWriter
  private readonly now: () => number
  private readonly onDiscard?: (runId: string) => void
  private readonly onSettle?: (
    runId: string,
    meta: BackgroundTaskStartMeta,
    settle: BackgroundTaskSettleInfo
  ) => void

  constructor(options: BackgroundTaskRegistryOptions<T>) {
    this.projectForJournal = options.projectForJournal
    this.journal = options.journal
    this.now = options.now ?? Date.now
    this.onDiscard = options.onDiscard
    this.onSettle = options.onSettle
  }

  start(
    runId: string,
    meta: BackgroundTaskStartMeta,
    promise: Promise<T>,
    controls?: BackgroundTaskControls
  ): void {
    if (this.runs.has(runId)) {
      void promise.catch(() => undefined)
      throw new Error("Background run already tracked")
    }
    if (this.journal?.renewLease) {
      const journal = this.journal
      let admissionCommitted = false
      // Admission precedes settlement even for an already-resolved producer.
      // Attach rejection handling immediately while the storage write is pending.
      const outcome = promise.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      let admitted: Promise<void>
      try {
        admitted = Promise.resolve(journal.recordStart({ runId, ...meta, status: "running" }))
      } catch (error) {
        admitted = Promise.reject(error)
      }
      admitted = admitted.catch((error) => {
        if (controls?.onLeaseLost) controls.onLeaseLost()
        else
          void Promise.resolve()
            .then(() => controls?.cancel?.())
            .catch(() => undefined)
        throw error
      })
      const execution = admitted.then(async () => {
        admissionCommitted = true
        const result = await outcome
        if ("error" in result) throw result.error
        return result.value
      })
      this.startAccepted(
        runId,
        meta,
        execution,
        {
          ...journal,
          recordSettle: (id, patch) => {
            if (!admissionCommitted) throw new Error("Background admission did not commit")
            return journal.recordSettle(id, patch)
          },
        },
        controls
      )
      return
    }
    this.track(runId, meta, promise, controls, true)
  }

  /** The caller already committed admission; settlement must precede delivery. */
  startAccepted(
    runId: string,
    meta: BackgroundTaskStartMeta,
    promise: Promise<T>,
    journal: BackgroundTaskJournalWriter,
    controls?: BackgroundTaskControls
  ): void {
    if (this.runs.has(runId)) {
      void promise.catch(() => undefined)
      throw new Error("Background run already tracked")
    }
    let settlementCommitted = false
    let ownershipLost = false
    let rejectOwnership!: (error: Error) => void
    const loss = new Promise<never>((_, reject) => {
      rejectOwnership = reject
    })
    const stopLease = journal.renewLease
      ? startLeaseHeartbeat({
          intervalMs: journal.leaseIntervalMs ?? 20_000,
          renew: async () => ((await journal.renewLease!(runId)) ? "renewed" : "lost"),
          onLeaseLost: () => {
            ownershipLost = true
            rejectOwnership(new Error("Background task ownership lost"))
            if (controls?.onLeaseLost) controls.onLeaseLost()
            else
              void Promise.resolve()
                .then(() => controls?.cancel?.())
                .catch(() => undefined)
          },
        })
      : () => {}
    const committed = Promise.race([promise, loss])
      .then(
        async (value) => {
          if (ownershipLost) throw new Error("Background task ownership lost")
          const projection = this.projectForJournal(value)
          await journal.recordSettle(runId, {
            status: projection.error ? "error" : "done",
            settledAt: this.now(),
            resultText: projection.text,
            ...(projection.error ? { error: projection.error } : {}),
            ...(projection.usage ? { usage: projection.usage } : {}),
          })
          settlementCommitted = true
          return value
        },
        async (error) => {
          if (ownershipLost) throw error
          await journal.recordSettle(runId, {
            status: "error",
            settledAt: this.now(),
            error: errorMessage(error),
          })
          settlementCommitted = true
          throw error
        }
      )
      .finally(stopLease)
    this.track(runId, meta, committed, controls, false, () => settlementCommitted)
    this.runs.get(runId)!.stopLease = stopLease
  }

  private track(
    runId: string,
    meta: BackgroundTaskStartMeta,
    promise: Promise<T>,
    controls: BackgroundTaskControls | undefined,
    writeJournal: boolean,
    failureCommitted: () => boolean = () => false
  ): void {
    const entry: Entry<T> = {
      promise,
      meta,
      status: "running",
      ...(controls ? { controls } : {}),
    }
    this.runs.set(runId, entry)
    if (writeJournal)
      this.writeJournal(() =>
        this.journal?.recordStart({
          runId,
          ...meta,
          status: "running",
        })
      )

    promise.then(
      (value) => {
        const projection = this.projectForJournal(value)
        const settledAt = this.now()
        // A run whose promise RESOLVES with an error-shaped projection (the
        // dispatch path never rejects) settles as "error", not "done" — the
        // journal must be honest for collect/delivery/UI consumers.
        const status = projection.error ? ("error" as const) : ("done" as const)
        entry.status = status
        entry.settledAt = settledAt
        entry.resultText = projection.text
        if (projection.error) entry.error = projection.error
        entry.usage = projection.usage
        const settle = {
          status,
          settledAt,
          resultText: projection.text,
          ...(projection.error ? { error: projection.error } : {}),
          ...(projection.usage ? { usage: projection.usage } : {}),
        }
        if (writeJournal) this.writeJournal(() => this.journal?.recordSettle(runId, settle))
        this.fireOnSettle(runId, meta, settle)
      },
      (error) => {
        const message = errorMessage(error)
        const settledAt = this.now()
        entry.status = "error"
        entry.settledAt = settledAt
        entry.error = message
        if (writeJournal)
          this.writeJournal(() =>
            this.journal?.recordSettle(runId, {
              status: "error",
              settledAt,
              error: message,
            })
          )
        if (writeJournal || failureCommitted())
          this.fireOnSettle(runId, meta, { status: "error", settledAt, error: message })
        else {
          try {
            this.onDiscard?.(runId)
          } catch {
            // Local observers cannot turn a rejected result into a delivery.
          }
        }
      }
    )
  }

  has(runId: string): boolean {
    return this.runs.has(runId)
  }

  async collect(runId: string): Promise<T | undefined> {
    const entry = this.runs.get(runId)
    if (!entry) return undefined
    try {
      return await entry.promise
    } finally {
      this.runs.delete(runId)
    }
  }

  list(): BackgroundTaskListEntry[] {
    return [...this.runs.entries()].map(([runId, entry]) => ({
      runId,
      ...entry.meta,
      status: entry.status,
      ...(entry.settledAt !== undefined ? { settledAt: entry.settledAt } : {}),
      ...(entry.resultText !== undefined ? { resultText: entry.resultText } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
      ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
      ...(entry.cancelled ? { cancelled: entry.cancelled } : {}),
    }))
  }

  countRunning(): number {
    let count = 0
    for (const entry of this.runs.values()) {
      if (entry.status === "running") count += 1
    }
    return count
  }

  cancel(runId: string): boolean {
    const requested = this.requestCancellation(runId)
    return typeof requested === "boolean" ? requested : true
  }

  /** Await the durable cancellation receipt before a caller announces success. */
  async cancelAndWait(runId: string): Promise<boolean> {
    return this.requestCancellation(runId)
  }

  private requestCancellation(runId: string): boolean | Promise<boolean> {
    const entry = this.runs.get(runId)
    if (!entry || entry.status !== "running" || !entry.controls?.cancel) return false
    try {
      const requested = entry.controls.cancel()
      if (requested && typeof requested.then === "function") {
        return requested.then(
          () => {
            entry.cancelled = true
            return true
          },
          (error) => {
            entry.error = errorMessage(error)
            return false
          }
        )
      }
      entry.cancelled = true
      return true
    } catch (error) {
      entry.error = errorMessage(error)
      return false
    }
  }

  /** Cancel every running entry matching the predicate; returns the count. */
  cancelWhere(predicate: (entry: BackgroundTaskListEntry) => boolean): number {
    let cancelled = 0
    for (const entry of this.list()) {
      if (entry.status === "running" && predicate(entry) && this.cancel(entry.runId)) {
        cancelled += 1
      }
    }
    return cancelled
  }

  __clearForTesting(): void {
    for (const entry of this.runs.values()) entry.stopLease?.()
    this.runs.clear()
  }

  private fireOnSettle(
    runId: string,
    meta: BackgroundTaskStartMeta,
    settle: BackgroundTaskSettleInfo
  ): void {
    try {
      this.onSettle?.(runId, meta, settle)
    } catch {
      // Settle listeners are best-effort observers; never break the lifecycle.
    }
  }

  private writeJournal(write: () => void | Promise<void>): void {
    try {
      const maybePromise = write()
      if (maybePromise && typeof (maybePromise as Promise<void>).catch === "function") {
        ;(maybePromise as Promise<void>).catch(() => undefined)
      }
    } catch {
      // Journal writes are best-effort; task lifecycle must keep its old in-memory contract.
    }
  }
}

/**
 * Flip every `running` journal row to `interrupted` (host process restarted
 * mid-run). Returns the freshly transitioned records — with the patch applied —
 * so boot-time reconciliation (e.g. opt-in auto-resume) can act on THIS boot's
 * interruptions only, never on stale history.
 */
export async function interruptRunningTasks(
  journal: BackgroundTaskJournal,
  options: { now?: () => number } = {}
): Promise<BackgroundTaskJournalRecord[]> {
  const now = options.now ?? Date.now
  const records = await journal.list()
  const interrupted = await Promise.all(
    records
      .filter((record) => record.status === "running")
      .map(async (record) => {
        const patch = {
          status: "interrupted" as const,
          settledAt: now(),
          error: INTERRUPTED_ERROR,
        }
        await journal.update(record.runId, patch)
        return { ...record, ...patch }
      })
  )
  return interrupted
}

export function backgroundTaskInterruptedMessage(runId: string): string {
  return `Background run "${runId}" was interrupted before it finished.`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
