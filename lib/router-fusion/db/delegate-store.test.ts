/**
 * delegate-store — the durable non-ledger state of a delegate run:
 * acceptance approvals (digest-bound, decide-once), patch sets (idempotent
 * indexing, apply-once), and the codec-sealed delegate step journal.
 */

import "fake-indexeddb/auto"

import { fusionContentCodec, type FusionContentCodec } from "./content-codec"
import { FusionDB } from "./fusion-db"
import type { DelegateStepRow } from "../runtime/delegate-step-journal"
import {
  approvalIdFor,
  createFusionDelegateStepStore,
  decideApproval,
  delegateStepKey,
  getApproval,
  listRunApprovals,
  listRunPatchSets,
  markPatchSetApplied,
  patchSetIdFor,
  pendingApprovalOf,
  recordApprovalRequest,
  recordPatchSet,
  type RecordApprovalInput,
  type RecordPatchSetInput,
} from "./delegate-store"

let dbCounter = 0
function harness() {
  const name = `fusion-delegate-test-${++dbCounter}`
  return { db: new FusionDB(name), name }
}

const summary = { paths: ["src/a.ts"], fileCount: 1, patchSha256: null, patchArtifactId: null }

function approvalInput(over: Partial<RecordApprovalInput> = {}): RecordApprovalInput {
  return {
    runId: "run-1",
    projectId: "p1",
    kind: "workspace_apply",
    requestDigest: "digest-1",
    revision: "rev-1",
    logicalStepId: "step-1",
    summary,
    requestedBy: "worker",
    now: 1_000,
    ...over,
  }
}

function patchInput(over: Partial<RecordPatchSetInput> = {}): RecordPatchSetInput {
  return {
    runId: "run-1",
    baseRevision: "rev-1",
    resultRevision: null,
    patchSha256: "sha-1",
    patchArtifactId: "artifact-1",
    paths: ["src/a.ts", "src/b.ts"],
    delivery: "patch_only",
    now: 1_000,
    ttlMs: 60_000,
    ...over,
  }
}

function stepRow(over: Partial<DelegateStepRow> = {}): DelegateStepRow {
  return {
    runId: "run-1",
    stepId: "step-1",
    kind: "turn_intents",
    requestHash: "hash-1",
    state: "committed",
    receipt: '{"ok":true}',
    encryptedReceipt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...over,
  }
}

describe("deterministic ids", () => {
  it("delegateStepKey joins run and step with a NUL separator", () => {
    expect(delegateStepKey("run-1", "step-2")).toBe("run-1\x00step-2")
  })

  it("approvalIdFor derives one id per (run, digest)", () => {
    expect(approvalIdFor("run-1", "digest-1")).toBe(approvalIdFor("run-1", "digest-1"))
    expect(approvalIdFor("run-1", "digest-1")).not.toBe(approvalIdFor("run-1", "digest-2"))
    expect(approvalIdFor("run-1", "digest-1")).not.toBe(approvalIdFor("run-2", "digest-1"))
    expect(approvalIdFor("run-1", "digest-1")).toMatch(/^[0-9a-f-]{36}$/)
  })

  it("patchSetIdFor derives one id per (run, patch)", () => {
    expect(patchSetIdFor("run-1", "sha-1")).toBe(patchSetIdFor("run-1", "sha-1"))
    expect(patchSetIdFor("run-1", "sha-1")).not.toBe(patchSetIdFor("run-1", "sha-2"))
  })
})

describe("acceptance approvals", () => {
  it("records a pending request once and returns the standing row on replay", async () => {
    const { db } = harness()
    const first = await recordApprovalRequest(db, approvalInput())
    expect(first.status).toBe("pending")
    expect(first.id).toBe(approvalIdFor("run-1", "digest-1"))

    // Re-asking with a later timestamp must not reset the recorded row.
    const again = await recordApprovalRequest(db, approvalInput({ now: 9_999 }))
    expect(again.createdAt).toBe(1_000)
    expect(await db.fusionAcceptanceApprovals.count()).toBe(1)
  })

  it("lists a run's approvals oldest first and fetches by id", async () => {
    const { db } = harness()
    await recordApprovalRequest(db, approvalInput({ requestDigest: "d-new", now: 2_000 }))
    await recordApprovalRequest(db, approvalInput({ requestDigest: "d-old", now: 1_000 }))
    const rows = await listRunApprovals(db, "run-1")
    expect(rows.map((r) => r.requestDigest)).toEqual(["d-old", "d-new"])
    expect(await getApproval(db, rows[0]!.id)).toMatchObject({ requestDigest: "d-old" })
    expect(await getApproval(db, "missing")).toBeUndefined()
  })

  it("reports the newest pending approval as what the run is parked on", async () => {
    const { db } = harness()
    expect(await pendingApprovalOf(db, "run-1")).toBeUndefined()
    const first = await recordApprovalRequest(db, approvalInput({ requestDigest: "d1", now: 1 }))
    const second = await recordApprovalRequest(db, approvalInput({ requestDigest: "d2", now: 2 }))
    expect((await pendingApprovalOf(db, "run-1"))!.id).toBe(second.id)
    await decideApproval(db, {
      runId: "run-1",
      approvalId: second.id,
      decision: "approve",
      now: 3,
    })
    expect((await pendingApprovalOf(db, "run-1"))!.id).toBe(first.id)
  })

  it("decides only the pending approval the caller named", async () => {
    const { db } = harness()
    const pending = await recordApprovalRequest(db, approvalInput())

    const notPending = await decideApproval(db, {
      runId: "no-such-run",
      approvalId: pending.id,
      decision: "approve",
      now: 2_000,
    })
    expect(notPending).toEqual({ ok: false, code: "APPROVAL_NOT_PENDING" })

    const mismatched = await decideApproval(db, {
      runId: "run-1",
      approvalId: approvalIdFor("run-1", "other-digest"),
      decision: "approve",
      now: 2_000,
    })
    expect(mismatched).toEqual({ ok: false, code: "APPROVAL_MISMATCH", pendingId: pending.id })
    // The untouched pending row stays pending.
    expect((await getApproval(db, pending.id))!.status).toBe("pending")

    const missing = await decideApproval(db, {
      runId: "run-1",
      approvalId: null,
      decision: "approve",
      now: 2_000,
    })
    expect(missing).toEqual({ ok: false, code: "APPROVAL_MISMATCH", pendingId: pending.id })
  })

  it("settles a decision once — approve writes decidedAt, deny keeps the reason", async () => {
    const { db } = harness()
    const pending = await recordApprovalRequest(db, approvalInput())
    const decided = await decideApproval(db, {
      runId: "run-1",
      approvalId: pending.id,
      decision: "deny",
      reason: "wrong scope",
      now: 5_000,
    })
    expect(decided).toMatchObject({ ok: true })
    if (!decided.ok) throw new Error("expected a decision")
    expect(decided.row).toMatchObject({
      status: "denied",
      decisionReason: "wrong scope",
      decidedAt: 5_000,
      updatedAt: 5_000,
    })

    // A replayed decide finds nothing pending and cannot flip the denial.
    const replay = await decideApproval(db, {
      runId: "run-1",
      approvalId: pending.id,
      decision: "approve",
      now: 6_000,
    })
    expect(replay).toEqual({ ok: false, code: "APPROVAL_NOT_PENDING" })
    expect((await getApproval(db, pending.id))!.status).toBe("denied")
  })
})

describe("patch sets", () => {
  it("indexes a run's patch idempotently and learns a late result revision", async () => {
    const { db } = harness()
    const first = await recordPatchSet(db, patchInput())
    expect(first.patchSetId).toBe(patchSetIdFor("run-1", "sha-1"))
    expect(first).toMatchObject({
      fileCount: 2,
      resultRevision: null,
      appliedRevision: null,
      expiresAt: 61_000,
    })

    // Same patch, staged again — now carrying the result revision.
    const second = await recordPatchSet(db, patchInput({ resultRevision: "rev-2", now: 9_999 }))
    expect(second.patchSetId).toBe(first.patchSetId)
    expect(second.resultRevision).toBe("rev-2")
    expect(second.createdAt).toBe(1_000)
    expect(await db.fusionPatchSets.count()).toBe(1)

    // Once the result revision is known, nothing about the row moves.
    const third = await recordPatchSet(db, patchInput({ resultRevision: "rev-3" }))
    expect(third.resultRevision).toBe("rev-2")
  })

  it("marks an apply once and lists a run's patch sets oldest first", async () => {
    const { db } = harness()
    const first = await recordPatchSet(db, patchInput({ patchSha256: "sha-a", now: 1 }))
    await recordPatchSet(db, patchInput({ patchSha256: "sha-b", now: 2 }))

    const applied = await markPatchSetApplied(db, {
      patchSetId: first.patchSetId,
      appliedRevision: "rev-9",
      now: 3_000,
    })
    expect(applied).toMatchObject({ appliedRevision: "rev-9", appliedAt: 3_000 })

    // A replayed apply returns the row it produced the first time.
    const replay = await markPatchSetApplied(db, {
      patchSetId: first.patchSetId,
      appliedRevision: "rev-OTHER",
      now: 4_000,
    })
    expect(replay!.appliedRevision).toBe("rev-9")
    expect(
      await markPatchSetApplied(db, { patchSetId: "missing", appliedRevision: "r", now: 1 })
    ).toBeUndefined()

    const rows = await listRunPatchSets(db, "run-1")
    expect(rows.map((r) => r.patchSha256)).toEqual(["sha-a", "sha-b"])
    expect(await listRunPatchSets(db, "other-run")).toEqual([])
  })
})

describe("delegate step journal store", () => {
  it("round-trips a receipt through the codec", async () => {
    const { db, name } = harness()
    const store = createFusionDelegateStepStore(db, fusionContentCodec(name))
    await store.put(stepRow())
    const got = await store.get("run-1", "step-1")
    expect(got).toMatchObject({ receipt: '{"ok":true}', encryptedReceipt: null })
    expect(await store.get("run-1", "missing")).toBeUndefined()
  })

  it("lists a run's steps oldest first with opened receipts", async () => {
    const { db, name } = harness()
    const store = createFusionDelegateStepStore(db, fusionContentCodec(name))
    await store.put(stepRow({ stepId: "s2", createdAt: 2 }))
    await store.put(stepRow({ stepId: "s1", createdAt: 1 }))
    const rows = await store.list("run-1")
    expect(rows.map((r) => r.stepId)).toEqual(["s1", "s2"])
    expect(await store.list("other-run")).toEqual([])
  })

  it("seals under the row's own primary key and opens on read", async () => {
    const { db } = harness()
    const seal = jest.fn(async () => ({
      content: null,
      encryptedContent: { v: 1 } as never,
    }))
    const open = jest.fn(async () => '{"ok":true}')
    const codec: FusionContentCodec = { encrypted: true, seal, open }
    const store = createFusionDelegateStepStore(db, codec)

    await store.put(stepRow({ runId: "run-9", stepId: "s-7" }))
    expect(seal).toHaveBeenCalledWith(
      "fusionDelegateSteps",
      delegateStepKey("run-9", "s-7"),
      "receipt",
      '{"ok":true}'
    )
    // The stored row holds the envelope, not the plaintext.
    const stored = await db.fusionDelegateSteps.get(["run-9", "s-7"])
    expect(stored!.receipt).toBeNull()
    expect(stored!.encryptedReceipt).toEqual({ v: 1 })

    const got = await store.get("run-9", "s-7")
    expect(open).toHaveBeenCalledWith(
      "fusionDelegateSteps",
      delegateStepKey("run-9", "s-7"),
      "receipt",
      { content: null, encryptedContent: { v: 1 } }
    )
    expect(got).toMatchObject({ receipt: '{"ok":true}', encryptedReceipt: null })
  })

  it("never touches the codec for a receipt-less step", async () => {
    const { db } = harness()
    const seal = jest.fn()
    const open = jest.fn()
    const store = createFusionDelegateStepStore(db, {
      encrypted: true,
      seal,
      open,
    } as unknown as FusionContentCodec)
    const bare = stepRow({ receipt: null })
    await store.put(bare)
    expect(seal).not.toHaveBeenCalled()
    const got = await store.get(bare.runId, bare.stepId)
    expect(got).toMatchObject({ receipt: null })
    expect(open).not.toHaveBeenCalled()
  })
})
