/**
 * The durable step journal a delegate run replays from (ADR-0188 B4, REC-06).
 *
 * A delegate run does things a model call cannot undo: it pins a revision, it
 * stages a patch into a worktree, it runs an acceptance command, it writes a
 * person's files. When a run resumes — after an approval, a reload, a crash,
 * a lease takeover — each of those must answer one of three ways:
 *
 * - **committed** → replay the receipt. The step already happened; doing it
 *   again would run the tests twice or apply a patch twice.
 * - **dispatched, never committed** → `UNKNOWN`. The side effect may or may
 *   not have happened, and nothing on this device can tell which. For an
 *   idempotent step (pinning the base, recording a turn's tool requests,
 *   staging into a fresh worktree) the workflow may dispatch again; for the
 *   others it goes to reconciliation and a person, and is NEVER re-run.
 * - **a different request under the same step id** → `mismatch`. The graph is
 *   not replaying itself, and the run stops rather than trusting the id.
 *
 * This module is the host half of `DelegateStepJournal`. It holds no storage
 * of its own: it drives a {@link DelegateStepJournalStore}, so the same
 * semantics run over the fusion database in production and over a map in a
 * test. `MemoryStepJournal` in the package is the reference behaviour and this
 * one is asserted against it.
 *
 * # The table WP-D4 must add (fusion DB v4)
 *
 * ```
 * fusionDelegateSteps: "&[runId+stepId], runId, [runId+state], kind, createdAt"
 * ```
 *
 * with the row of {@link DelegateStepRow}: `receipt` / `encryptedReceipt`
 * sealed through `fusionContentCodec("fusionDelegateSteps", <runId>\u0000<stepId>,
 * "receipt", json)` exactly as `fusionArtifacts.content` is, because a receipt
 * carries workspace-derived text (an acceptance report's failure messages).
 * Retention in `lib/data-governance/router-fusion-catalog.ts`: the run's own
 * retention — the journal is only meaningful while the run can still resume,
 * and it is what makes a resumed run safe, so it must not outlive nor predecease
 * the run row.
 */

import type {
  DelegateSideEffectKind,
  DelegateStepJournal,
  StepJournalBegin,
} from "@cognia/router-fusion"

export type DelegateStepState = "prepared" | "dispatched" | "committed"

/** One logical step of one delegate run. The primary key is `[runId+stepId]`. */
export interface DelegateStepRow {
  runId: string
  stepId: string
  kind: DelegateSideEffectKind
  /** What the step was begun with; a different hash under the same id is a mismatch. */
  requestHash: string
  state: DelegateStepState
  /** The receipt as JSON, plaintext only for a database that is not account-scoped. */
  receipt: string | null
  /** The sealed receipt for an account-scoped database (same envelope as artifacts). */
  encryptedReceipt: unknown | null
  createdAt: number
  updatedAt: number
}

/**
 * The storage the journal drives. Reads and writes are per (run, step); the
 * journal never scans, so a Dexie implementation needs the compound primary
 * key and nothing else.
 */
export interface DelegateStepJournalStore {
  get(runId: string, stepId: string): Promise<DelegateStepRow | undefined>
  put(row: DelegateStepRow): Promise<void>
  /** Every step of a run, for the recovery sweep and the run's detail pane. */
  list(runId: string): Promise<DelegateStepRow[]>
}

export interface DelegateStepJournalInput {
  runId: string
  store: DelegateStepJournalStore
  now?: () => number
}

/** A receipt that cannot be stored is a bug in the caller, not a silent loss. */
function encodeReceipt(stepId: string, receipt: unknown): string {
  let encoded: string
  try {
    encoded = JSON.stringify(receipt ?? null)
  } catch (error) {
    throw new Error(
      `the receipt of step ${stepId} is not JSON-serialisable: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (encoded === undefined) {
    throw new Error(`the receipt of step ${stepId} is not JSON-serialisable`)
  }
  return encoded
}

/**
 * The host journal for one run.
 *
 * Note what it does NOT do: it never decides whether an unknown step may be
 * re-run. That is the workflow's call, from `IDEMPOTENT_SIDE_EFFECTS`, and
 * keeping it there means one rule instead of two that can disagree.
 */
export function createDelegateStepJournal(input: DelegateStepJournalInput): DelegateStepJournal {
  const now = input.now ?? Date.now
  const { runId, store } = input

  return {
    async begin({ stepId, kind, requestHash }): Promise<StepJournalBegin> {
      const existing = await store.get(runId, stepId)
      if (!existing) {
        const at = now()
        await store.put({
          runId,
          stepId,
          kind,
          requestHash,
          state: "prepared",
          receipt: null,
          encryptedReceipt: null,
          createdAt: at,
          updatedAt: at,
        })
        return { kind: "fresh" }
      }
      if (existing.kind !== kind || existing.requestHash !== requestHash) {
        return { kind: "mismatch" }
      }
      if (existing.state === "committed") {
        // A committed step with no readable receipt is not a replay: the
        // journal cannot say what happened, so the step is UNKNOWN and the
        // workflow decides (never a silent re-run of a non-idempotent effect).
        if (existing.receipt === null) return { kind: "unknown" }
        try {
          return { kind: "replay", receipt: JSON.parse(existing.receipt) as unknown }
        } catch {
          return { kind: "unknown" }
        }
      }
      if (existing.state === "dispatched") return { kind: "unknown" }
      return { kind: "fresh" }
    },

    async markDispatched(stepId: string): Promise<void> {
      const existing = await store.get(runId, stepId)
      if (!existing) throw new Error(`no journal step ${stepId}`)
      if (existing.state === "committed") throw new Error(`step ${stepId} is already committed`)
      await store.put({ ...existing, state: "dispatched", updatedAt: now() })
    },

    async commit(stepId: string, receipt: unknown): Promise<void> {
      const existing = await store.get(runId, stepId)
      if (!existing || existing.state !== "dispatched") {
        throw new Error(`step ${stepId} is not dispatched`)
      }
      await store.put({
        ...existing,
        state: "committed",
        receipt: encodeReceipt(stepId, receipt),
        encryptedReceipt: null,
        updatedAt: now(),
      })
    },
  }
}

/**
 * An in-memory store with the same semantics as the durable one.
 *
 * Not only for tests: it is what a run uses before WP-D4 adds the table, and
 * the difference it makes is explicit — a run whose journal is in memory
 * cannot survive a reload, so a resumed run finds no steps and refuses to
 * re-run the non-idempotent ones rather than repeating them.
 */
export function createMemoryDelegateStepJournalStore(): DelegateStepJournalStore & {
  readonly rows: ReadonlyMap<string, DelegateStepRow>
  /** Test seam: a step dispatched and never answered, as a crash leaves it. */
  strand(runId: string, stepId: string, kind: DelegateSideEffectKind, requestHash: string): void
} {
  const rows = new Map<string, DelegateStepRow>()
  const key = (runId: string, stepId: string) => `${runId}\u0000${stepId}`
  return {
    rows,
    async get(runId, stepId) {
      return rows.get(key(runId, stepId))
    },
    async put(row) {
      rows.set(key(row.runId, row.stepId), { ...row })
    },
    async list(runId) {
      return [...rows.values()]
        .filter((row) => row.runId === runId)
        .sort((a, b) => a.createdAt - b.createdAt)
    },
    strand(runId, stepId, kind, requestHash) {
      const at = Date.now()
      rows.set(key(runId, stepId), {
        runId,
        stepId,
        kind,
        requestHash,
        state: "dispatched",
        receipt: null,
        encryptedReceipt: null,
        createdAt: at,
        updatedAt: at,
      })
    },
  }
}
