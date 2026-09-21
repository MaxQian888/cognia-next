/**
 * A delegate run's durable state outside the money ledger (ADR-0188 B4, D39).
 *
 * Three stores, one module, because they answer the same question from three
 * angles — "what did this run already do, and what was it allowed to do?":
 *
 * - **`fusionAcceptanceApprovals`** — what a person allowed, bound to a digest
 *   (API-08). The row id is derived from the run and the digest, so the id a
 *   surface presents IS the thing being approved: other arguments, or the same
 *   arguments against a workspace that moved, hash differently and cannot be
 *   released by an approval given for the first one. Approving is idempotent
 *   and deciding twice is refused, so a replayed resume never flips a denial.
 * - **`fusionPatchSets`** — the change a run produced, indexed by the revision
 *   it applies to. The patch document itself is an artifact; this row is what
 *   the review pane lists and what an approved apply marks as landed, so a
 *   replayed apply finds `appliedRevision` instead of writing twice.
 * - **`fusionDelegateSteps`** — the step journal `delegate-step-journal.ts`
 *   drives (REC-06). Its receipts carry workspace-derived text (an acceptance
 *   report's failure messages), so they are sealed with the same content codec
 *   `fusionArtifacts.content` uses, under the row's own primary key.
 *
 * None of this moves money: `ledger-store.ts` stays the only writer of that.
 *
 * Sealing awaits WebCrypto, which would commit an open IndexedDB transaction,
 * so every seal happens before its write and every open after its read — the
 * rule the artifact store already follows.
 */

import {
  uuidFromName,
  type DelegateApprovalKind,
  type DelegateApprovalSummary,
} from "@cognia/router-fusion"

import type { FusionContentCodec } from "./content-codec"
import type { FusionDB } from "./fusion-db"
import type { DelegateStepJournalStore, DelegateStepRow } from "../runtime/delegate-step-journal"
import type { FusionAcceptanceApprovalRow, FusionApprovalStatus, FusionPatchSetRow } from "./types"

/** The table's own primary key, spelled the one way every reader uses. */
export function delegateStepKey(runId: string, stepId: string): string {
  return `${runId}\u0000${stepId}`
}

/** The deterministic id of one run's approval of one digest. */
export function approvalIdFor(runId: string, requestDigest: string): string {
  return uuidFromName(`${runId}\u0000${requestDigest}`)
}

/** The deterministic id of one run's patch set. */
export function patchSetIdFor(runId: string, patchSha256: string): string {
  return uuidFromName(`${runId}\u0000${patchSha256}`)
}

// ── approvals ────────────────────────────────────────────────────────────────

export interface RecordApprovalInput {
  runId: string
  projectId: string | null
  kind: DelegateApprovalKind
  requestDigest: string
  revision: string
  logicalStepId: string
  summary: DelegateApprovalSummary
  requestedBy: "worker" | "lead" | "runtime"
  now: number
}

/**
 * The row for this digest, creating it as `pending` the first time.
 *
 * Idempotent on purpose: the workflow asks again on every replay, and asking
 * must never reset a decision a person already made — the recorded row is
 * returned exactly as it stands.
 */
export async function recordApprovalRequest(
  db: FusionDB,
  input: RecordApprovalInput
): Promise<FusionAcceptanceApprovalRow> {
  const id = approvalIdFor(input.runId, input.requestDigest)
  return db.transaction("rw", db.fusionAcceptanceApprovals, async () => {
    const existing = await db.fusionAcceptanceApprovals.get(id)
    if (existing) return existing
    const row: FusionAcceptanceApprovalRow = {
      id,
      runId: input.runId,
      projectId: input.projectId,
      kind: input.kind,
      requestDigest: input.requestDigest,
      revision: input.revision,
      logicalStepId: input.logicalStepId,
      status: "pending",
      summary: input.summary,
      requestedBy: input.requestedBy,
      decisionReason: null,
      decidedAt: null,
      createdAt: input.now,
      updatedAt: input.now,
    }
    await db.fusionAcceptanceApprovals.put(row)
    return row
  })
}

export async function getApproval(
  db: FusionDB,
  approvalId: string
): Promise<FusionAcceptanceApprovalRow | undefined> {
  return db.fusionAcceptanceApprovals.get(approvalId)
}

/** Every approval of a run, oldest first: the review pane's history. */
export async function listRunApprovals(
  db: FusionDB,
  runId: string
): Promise<FusionAcceptanceApprovalRow[]> {
  return db.fusionAcceptanceApprovals.where("runId").equals(runId).sortBy("createdAt")
}

/**
 * The request a run is parked on: its newest pending approval, or undefined.
 * A run parks on one thing at a time, and the newest row is that thing.
 */
export async function pendingApprovalOf(
  db: FusionDB,
  runId: string
): Promise<FusionAcceptanceApprovalRow | undefined> {
  const pending = await db.fusionAcceptanceApprovals
    .where("[runId+status]")
    .equals([runId, "pending" satisfies FusionApprovalStatus])
    .sortBy("createdAt")
  return pending.at(-1)
}

export type DecideApprovalOutcome =
  | { ok: true; row: FusionAcceptanceApprovalRow }
  /** No pending request: nothing to decide, and nothing was changed. */
  | { ok: false; code: "APPROVAL_NOT_PENDING" }
  /**
   * The decision named something other than what the run is waiting on — a
   * different digest, a stale revision, or another run's approval. The pending
   * row is left exactly as it was (API-08).
   */
  | { ok: false; code: "APPROVAL_MISMATCH"; pendingId: string }

/**
 * Settle the approval a run is parked on, and only if the caller named it.
 *
 * The caller must present the approval's id, which is derived from the digest,
 * so this is the digest check: `approvalId` that is absent, belongs to another
 * run, or names an older request is `APPROVAL_MISMATCH`, and the pending
 * request stays pending and undecided.
 */
export async function decideApproval(
  db: FusionDB,
  input: {
    runId: string
    approvalId: string | null | undefined
    decision: "approve" | "deny"
    reason?: string | null
    now: number
  }
): Promise<DecideApprovalOutcome> {
  return db.transaction("rw", db.fusionAcceptanceApprovals, async () => {
    const pending = await pendingApprovalOf(db, input.runId)
    if (!pending) return { ok: false as const, code: "APPROVAL_NOT_PENDING" as const }
    if (!input.approvalId || input.approvalId !== pending.id) {
      return { ok: false as const, code: "APPROVAL_MISMATCH" as const, pendingId: pending.id }
    }
    const row: FusionAcceptanceApprovalRow = {
      ...pending,
      status: input.decision === "approve" ? "approved" : "denied",
      decisionReason: input.reason ?? null,
      decidedAt: input.now,
      updatedAt: input.now,
    }
    await db.fusionAcceptanceApprovals.put(row)
    return { ok: true as const, row }
  })
}

// ── patch sets ───────────────────────────────────────────────────────────────

export interface RecordPatchSetInput {
  runId: string
  baseRevision: string
  resultRevision: string | null
  patchSha256: string
  patchArtifactId: string
  paths: readonly string[]
  delivery: "patch_only" | "workspace_updated"
  now: number
  ttlMs: number
}

/** Index a run's combined patch. Idempotent: the same patch is the same row. */
export async function recordPatchSet(
  db: FusionDB,
  input: RecordPatchSetInput
): Promise<FusionPatchSetRow> {
  const patchSetId = patchSetIdFor(input.runId, input.patchSha256)
  return db.transaction("rw", db.fusionPatchSets, async () => {
    const existing = await db.fusionPatchSets.get(patchSetId)
    if (existing) {
      // A second staging of the same patch can learn the result revision the
      // first one did not have yet; nothing else about it can change.
      if (existing.resultRevision === null && input.resultRevision !== null) {
        const updated = { ...existing, resultRevision: input.resultRevision }
        await db.fusionPatchSets.put(updated)
        return updated
      }
      return existing
    }
    const row: FusionPatchSetRow = {
      patchSetId,
      runId: input.runId,
      baseRevision: input.baseRevision,
      resultRevision: input.resultRevision,
      patchSha256: input.patchSha256,
      patchArtifactId: input.patchArtifactId,
      fileCount: input.paths.length,
      paths: [...input.paths],
      delivery: input.delivery,
      appliedRevision: null,
      appliedAt: null,
      createdAt: input.now,
      expiresAt: input.now + input.ttlMs,
    }
    await db.fusionPatchSets.put(row)
    return row
  })
}

/** Record that an approved apply landed this patch in the user's workspace. */
export async function markPatchSetApplied(
  db: FusionDB,
  input: { patchSetId: string; appliedRevision: string; now: number }
): Promise<FusionPatchSetRow | undefined> {
  return db.transaction("rw", db.fusionPatchSets, async () => {
    const existing = await db.fusionPatchSets.get(input.patchSetId)
    if (!existing) return undefined
    // An apply lands once. A replay finds the revision it already produced.
    if (existing.appliedRevision !== null) return existing
    const row = { ...existing, appliedRevision: input.appliedRevision, appliedAt: input.now }
    await db.fusionPatchSets.put(row)
    return row
  })
}

export async function listRunPatchSets(db: FusionDB, runId: string): Promise<FusionPatchSetRow[]> {
  return db.fusionPatchSets.where("runId").equals(runId).sortBy("createdAt")
}

// ── the step journal's storage ───────────────────────────────────────────────

/**
 * `fusionDelegateSteps` as the step journal reads and writes it.
 *
 * The journal hands this store a row whose `receipt` is plain JSON and expects
 * one back the same way; the sealing is entirely this module's, exactly as the
 * artifact store seals `content`. A row an account-scoped database wrote is
 * unreadable while the vault is locked, and the codec says so with an
 * infrastructure fault rather than a lost receipt — a delegate run must never
 * conclude "no receipt, so nothing happened".
 */
export function createFusionDelegateStepStore(
  db: FusionDB,
  codec: FusionContentCodec
): DelegateStepJournalStore {
  const open = async (row: DelegateStepRow): Promise<DelegateStepRow> => {
    if (row.encryptedReceipt === null && row.receipt === null) return row
    const receipt = await codec.open(
      "fusionDelegateSteps",
      delegateStepKey(row.runId, row.stepId),
      "receipt",
      {
        content: row.receipt,
        encryptedContent: (row.encryptedReceipt ?? null) as never,
      }
    )
    return { ...row, receipt, encryptedReceipt: null }
  }
  return {
    async get(runId, stepId) {
      const row = await db.fusionDelegateSteps.get([runId, stepId])
      return row ? open(row) : undefined
    },
    async put(row) {
      const sealed =
        row.receipt === null
          ? { content: null, encryptedContent: null }
          : await codec.seal(
              "fusionDelegateSteps",
              delegateStepKey(row.runId, row.stepId),
              "receipt",
              row.receipt
            )
      await db.fusionDelegateSteps.put({
        ...row,
        receipt: sealed.content,
        encryptedReceipt: sealed.encryptedContent,
      })
    },
    async list(runId) {
      const rows = await db.fusionDelegateSteps.where("runId").equals(runId).sortBy("createdAt")
      const opened: DelegateStepRow[] = []
      for (const row of rows) opened.push(await open(row))
      return opened
    },
  }
}
