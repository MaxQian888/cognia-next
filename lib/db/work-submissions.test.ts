/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import type { EncryptedContentEnvelopeV1 } from "@cognia/rag"

import { __resetDbForTesting, getDb } from "./schema"
import {
  bindExecutionContextBundle,
  claimWorkSubmission,
  countOpenWorkSubmissions,
  findWorkSubmissionByIdempotencyKey,
  getExecutionContextBundle,
  getWorkInputBatch,
  getWorkSubmission,
  getWorkSubmissionBundle,
  listClaimableWorkSubmissions,
  listWorkSubmissions,
  markWorkSubmissionDispatched,
  pruneExpiredWorkSubmissionPayloads,
  releaseWorkSubmission,
  renewWorkSubmissionLease,
  settleWorkSubmissionRow,
  toExecutionContextRef,
  WORK_SUBMISSION_LEASE_TTL_MS,
  type ExecutionContextBundleRow,
  type WorkInputBatchRow,
  type WorkSubmissionRow,
} from "./work-submissions"

const NOW = 1_755_000_000_000

const envelope: EncryptedContentEnvelopeV1 = {
  version: 1,
  algorithm: "AES-256-GCM",
  keyId: "key-1",
  iv: "aXY=",
  ciphertext: "Y3Q=",
  aadHash: "f".repeat(64),
}

function submission(overrides: Partial<WorkSubmissionRow> = {}): WorkSubmissionRow {
  return {
    id: "submission-1",
    accountId: "account-1",
    idempotencyKey: "chat:session-1:action-1",
    runId: "run-1",
    turnId: "turn-1",
    sessionId: "session-1",
    runtimeTargetId: "target-1",
    sourceKind: "chat",
    sourceId: "session-1",
    availabilityPolicy: "wait",
    dispatchState: "pending",
    nextAttemptAt: NOW,
    attemptCount: 0,
    inputBatchId: "batch-1",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function inputBatch(overrides: Partial<WorkInputBatchRow> = {}): WorkInputBatchRow {
  return {
    id: "batch-1",
    submissionId: "submission-1",
    digest: "wsv1-input",
    visibleMessageIds: ["message-1"],
    attachments: [],
    envelope,
    createdAt: NOW,
    expiresAt: NOW + 1000,
    ...overrides,
  }
}

function contextBundle(
  overrides: Partial<ExecutionContextBundleRow> = {}
): ExecutionContextBundleRow {
  return {
    id: "bundle-1",
    submissionId: "submission-1",
    digest: "wsv1-context",
    projectId: "project-1",
    workspaceBindingRef: "workspace-main",
    baseRef: "refs/heads/dev",
    envelope,
    createdAt: NOW,
    expiresAt: NOW + 1000,
    ...overrides,
  }
}

async function seed(row: WorkSubmissionRow = submission()): Promise<WorkSubmissionRow> {
  await getDb().workSubmissions.put(row)
  return row
}

describe("work submission storage", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  describe("idempotency", () => {
    it("finds an existing submission by account and idempotency key", async () => {
      await seed()
      const found = await findWorkSubmissionByIdempotencyKey("account-1", "chat:session-1:action-1")
      expect(found?.id).toBe("submission-1")
    })

    it("scopes the lookup to the account", async () => {
      // The same key under another account must not resolve — otherwise one
      // account's redelivery could attach to another's work.
      await seed()
      const found = await findWorkSubmissionByIdempotencyKey("account-2", "chat:session-1:action-1")
      expect(found).toBeUndefined()
    })

    it("refuses a duplicate key within one account at the storage layer", async () => {
      await seed()
      await expect(
        getDb().workSubmissions.put(submission({ id: "submission-2" }))
      ).rejects.toThrow()
    })

    it("allows the same key under a different account", async () => {
      await seed()
      await expect(
        getDb().workSubmissions.put(submission({ id: "submission-2", accountId: "account-2" }))
      ).resolves.toBeDefined()
    })
  })

  describe("claiming", () => {
    it("claims a pending submission and stamps a lease", async () => {
      await seed()
      const claimed = await claimWorkSubmission("submission-1", "runner-a", NOW)
      expect(claimed).toMatchObject({
        dispatchState: "claimed",
        leaseOwner: "runner-a",
        leaseExpiresAt: NOW + WORK_SUBMISSION_LEASE_TTL_MS,
        attemptCount: 1,
      })
    })

    it("claims a blocked submission, because an unavailable target is retryable", async () => {
      await seed(submission({ dispatchState: "blocked" }))
      expect(await claimWorkSubmission("submission-1", "runner-a", NOW)).toBeDefined()
    })

    it("lets exactly one of two racing runners win", async () => {
      await seed()
      const [first, second] = await Promise.all([
        claimWorkSubmission("submission-1", "runner-a", NOW),
        claimWorkSubmission("submission-1", "runner-b", NOW),
      ])
      expect([first, second].filter(Boolean)).toHaveLength(1)
    })

    it("refuses to claim while another runner's lease is live", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "runner-a", NOW)
      expect(await claimWorkSubmission("submission-1", "runner-b", NOW + 1)).toBeUndefined()
    })

    it("refuses a dispatched takeover when the prior runtime renewed before the CAS", async () => {
      await seed(
        submission({
          dispatchState: "dispatched",
          leaseOwner: "runner-a",
          leaseExpiresAt: NOW + 10,
        })
      )
      expect(await claimWorkSubmission("submission-1", "runner-b", NOW + 1)).toBeUndefined()
    })

    it("reclaims once the previous lease has expired", async () => {
      // A runner that died holding a lease must not strand the work forever.
      await seed()
      await claimWorkSubmission("submission-1", "runner-a", NOW)
      const reclaimed = await claimWorkSubmission(
        "submission-1",
        "runner-b",
        NOW + WORK_SUBMISSION_LEASE_TTL_MS + 1
      )
      expect(reclaimed?.leaseOwner).toBe("runner-b")
      expect(reclaimed?.attemptCount).toBe(2)
    })

    it("reclaims a claimed row that carries no lease at all", async () => {
      // A crash between marking a row claimed and stamping its lease would
      // otherwise strand the work forever — the exact failure this ledger
      // exists to prevent. A missing lease reads as an expired one.
      await seed(submission({ dispatchState: "claimed", leaseOwner: "runner-gone" }))
      const reclaimed = await claimWorkSubmission("submission-1", "runner-b", NOW)
      expect(reclaimed?.leaseOwner).toBe("runner-b")
    })

    it("reclaims a dispatched row after its previous process lease expired", async () => {
      await seed(
        submission({
          dispatchState: "dispatched",
          attemptCount: 1,
          leaseOwner: "runner-gone",
          leaseExpiresAt: NOW - 1,
        })
      )
      const reclaimed = await claimWorkSubmission("submission-1", "runner-b", NOW)
      expect(reclaimed).toMatchObject({
        dispatchState: "claimed",
        leaseOwner: "runner-b",
        attemptCount: 2,
        takeoverRequired: true,
      })
    })

    it("refuses to claim a settled submission", async () => {
      await seed(submission({ dispatchState: "settled" }))
      expect(await claimWorkSubmission("submission-1", "runner-a", NOW)).toBeUndefined()
    })

    it("requires even the same logical owner to use the renewal seam", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "live-chat", NOW)
      expect(await claimWorkSubmission("submission-1", "live-chat", NOW + 10)).toBeUndefined()
    })

    it("returns undefined for a missing submission", async () => {
      expect(await claimWorkSubmission("nope", "runner-a", NOW)).toBeUndefined()
    })
  })

  describe("lease renewal", () => {
    it("extends only the current claimed owner", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "live-chat", NOW)
      expect(await renewWorkSubmissionLease("submission-1", "live-chat", NOW + 10)).toBe("renewed")
      expect(await renewWorkSubmissionLease("submission-1", "other", NOW + 20)).toBe("lost")
    })

    it("renews a dispatched turn until terminal settlement closes it", async () => {
      await seed(
        submission({
          dispatchState: "dispatched",
          leaseOwner: "live-chat",
          leaseExpiresAt: NOW + 1,
        })
      )
      expect(await renewWorkSubmissionLease("submission-1", "live-chat", NOW + 10)).toBe("renewed")
      await getDb().workSubmissions.update("submission-1", { dispatchState: "settled" })
      expect(await renewWorkSubmissionLease("submission-1", "live-chat", NOW + 20)).toBe("closed")
    })
  })

  describe("context binding", () => {
    it("binds the frozen context and records the fingerprint", async () => {
      await seed()
      const result = await bindExecutionContextBundle(
        "submission-1",
        contextBundle(),
        { executionFingerprint: "aexf1-abc", specAuthority: "shadow" },
        NOW
      )
      expect(result).toEqual({ bound: true, contextBundleId: "bundle-1" })
      expect(await getWorkSubmission("submission-1")).toMatchObject({
        contextBundleId: "bundle-1",
        executionFingerprint: "aexf1-abc",
        specAuthority: "shadow",
      })
    })

    it("is write-once, so a retry cannot re-resolve the context", async () => {
      // This is the enforcement point for "a retry replays the original
      // surroundings" rather than whatever the host looks like now.
      await seed()
      await bindExecutionContextBundle("submission-1", contextBundle(), {}, NOW)
      const second = await bindExecutionContextBundle(
        "submission-1",
        contextBundle({ id: "bundle-2", projectId: "project-moved" }),
        { executionFingerprint: "aexf1-different" },
        NOW + 1
      )
      expect(second).toEqual({ bound: false, contextBundleId: "bundle-1" })
      const stored = await getExecutionContextBundle("submission-1")
      expect(stored?.id).toBe("bundle-1")
      expect(stored?.projectId).toBe("project-1")
      expect((await getWorkSubmission("submission-1"))?.executionFingerprint).toBeUndefined()
    })

    it("throws for a missing submission rather than orphaning a bundle", async () => {
      await expect(bindExecutionContextBundle("nope", contextBundle(), {}, NOW)).rejects.toThrow(
        "Work submission not found: nope"
      )
      expect(await getDb().executionContextBundles.count()).toBe(0)
    })
  })

  describe("dispatch transitions", () => {
    it("marks a claimed submission dispatched", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "runner-a", NOW)
      await markWorkSubmissionDispatched("submission-1", NOW + 1)
      expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("dispatched")
    })

    it("never reopens a settled submission", async () => {
      await seed(submission({ dispatchState: "settled" }))
      await markWorkSubmissionDispatched("submission-1", NOW + 1)
      expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("settled")
    })

    it("ignores a missing submission", async () => {
      await expect(markWorkSubmissionDispatched("nope", NOW)).resolves.toBeUndefined()
    })

    it("releases back to pending with a backoff and clears the lease", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "runner-a", NOW)
      await releaseWorkSubmission(
        "submission-1",
        { dispatchState: "pending", nextAttemptAt: NOW + 5_000, errorCode: "transient" },
        NOW + 1
      )
      const row = await getWorkSubmission("submission-1")
      expect(row).toMatchObject({
        dispatchState: "pending",
        nextAttemptAt: NOW + 5_000,
        errorCode: "transient",
      })
      // Asserted by absence rather than `toMatchObject`: Dexie drops
      // `undefined` keys on write, so the stored row has no lease fields at
      // all. Either way, no runner holds this submission.
      expect(row?.leaseOwner).toBeUndefined()
      expect(row?.leaseExpiresAt).toBeUndefined()
    })

    it("records an unavailable target as blocked rather than errored", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "runner-a", NOW)
      await releaseWorkSubmission(
        "submission-1",
        { dispatchState: "blocked", nextAttemptAt: NOW + 1_000 },
        NOW + 1
      )
      expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("blocked")
    })

    it("refuses to release a settled submission", async () => {
      await seed(submission({ dispatchState: "settled" }))
      await releaseWorkSubmission(
        "submission-1",
        { dispatchState: "pending", nextAttemptAt: NOW },
        NOW
      )
      expect((await getWorkSubmission("submission-1"))?.dispatchState).toBe("settled")
    })
  })

  describe("settling", () => {
    it("seals a submission and reports that this call won", async () => {
      await seed()
      expect(await settleWorkSubmissionRow("submission-1", "completed", NOW + 5)).toBe(true)
      expect(await getWorkSubmission("submission-1")).toMatchObject({
        dispatchState: "settled",
        terminalOutcome: "completed",
        settledAt: NOW + 5,
      })
    })

    it("treats an empty reply as a successful terminal outcome", async () => {
      await seed()
      await settleWorkSubmissionRow("submission-1", "no_response", NOW)
      expect((await getWorkSubmission("submission-1"))?.terminalOutcome).toBe("no_response")
    })

    it("lets only the first terminal write win", async () => {
      // The caller keys "write the assistant message exactly once" off this
      // boolean, so a second settle must report false and change nothing.
      await seed()
      expect(await settleWorkSubmissionRow("submission-1", "completed", NOW)).toBe(true)
      expect(await settleWorkSubmissionRow("submission-1", "failed", NOW + 1, "boom")).toBe(false)
      expect(await getWorkSubmission("submission-1")).toMatchObject({
        terminalOutcome: "completed",
        settledAt: NOW,
      })
    })

    it("records an error code alongside a failure", async () => {
      await seed()
      await settleWorkSubmissionRow("submission-1", "failed", NOW, "host_unavailable")
      expect((await getWorkSubmission("submission-1"))?.errorCode).toBe("host_unavailable")
    })

    it("returns false for a missing submission", async () => {
      expect(await settleWorkSubmissionRow("nope", "completed", NOW)).toBe(false)
    })
  })

  describe("queries", () => {
    it("lists claimable rows and skips ones still backing off", async () => {
      await seed()
      await getDb().workSubmissions.put(
        submission({
          id: "submission-2",
          idempotencyKey: "key-2",
          nextAttemptAt: NOW + 10_000,
        })
      )
      const claimable = await listClaimableWorkSubmissions(NOW)
      expect(claimable.map((row) => row.id)).toEqual(["submission-1"])
    })

    it("includes a claimed row whose lease has expired", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "runner-a", NOW)
      const claimable = await listClaimableWorkSubmissions(NOW + WORK_SUBMISSION_LEASE_TTL_MS + 1)
      expect(claimable.map((row) => row.id)).toEqual(["submission-1"])
    })

    it("includes an expired dispatched row only for a restart recovery sweep", async () => {
      await seed(
        submission({
          dispatchState: "dispatched",
          attemptCount: 1,
          leaseOwner: "runner-gone",
          leaseExpiresAt: NOW - 1,
        })
      )
      expect(await listClaimableWorkSubmissions(NOW)).toEqual([])
      expect(
        (await listClaimableWorkSubmissions(NOW, 50, { includeDispatched: true })).map(
          (row) => row.id
        )
      ).toEqual(["submission-1"])
    })

    it("excludes a claimed row whose lease is still live", async () => {
      await seed()
      await claimWorkSubmission("submission-1", "runner-a", NOW)
      expect(await listClaimableWorkSubmissions(NOW + 1)).toEqual([])
    })

    it("includes a claimed row that carries no lease at all", async () => {
      await seed(submission({ dispatchState: "claimed", leaseOwner: "runner-gone" }))
      expect((await listClaimableWorkSubmissions(NOW)).map((row) => row.id)).toEqual([
        "submission-1",
      ])
    })

    it("excludes settled rows", async () => {
      await seed(submission({ dispatchState: "settled" }))
      expect(await listClaimableWorkSubmissions(NOW)).toEqual([])
    })

    it("counts only open submissions for the account", async () => {
      await seed()
      await getDb().workSubmissions.bulkPut([
        submission({ id: "s2", idempotencyKey: "k2", dispatchState: "settled" }),
        submission({ id: "s3", idempotencyKey: "k3", accountId: "account-2" }),
      ])
      expect(await countOpenWorkSubmissions("account-1")).toBe(1)
    })

    it("lists newest first and filters by session and state", async () => {
      await seed()
      await getDb().workSubmissions.put(
        submission({
          id: "submission-2",
          idempotencyKey: "key-2",
          sessionId: "session-2",
          createdAt: NOW + 10,
        })
      )
      expect((await listWorkSubmissions()).map((row) => row.id)).toEqual([
        "submission-2",
        "submission-1",
      ])
      expect((await listWorkSubmissions({ sessionId: "session-2" })).map((row) => row.id)).toEqual([
        "submission-2",
      ])
      expect(
        (await listWorkSubmissions({ dispatchStates: ["settled"] })).map((row) => row.id)
      ).toEqual([])
      expect(await listWorkSubmissions({ accountId: "account-2" })).toEqual([])
    })

    it("assembles a submission with its frozen rows", async () => {
      await seed()
      await getDb().workInputBatches.put(inputBatch())
      await getDb().executionContextBundles.put(contextBundle())
      const bundle = await getWorkSubmissionBundle("submission-1")
      expect(bundle?.submission.id).toBe("submission-1")
      expect(bundle?.inputBatch?.id).toBe("batch-1")
      expect(bundle?.contextBundle?.id).toBe("bundle-1")
    })

    it("omits absent frozen rows rather than inventing them", async () => {
      await seed()
      const bundle = await getWorkSubmissionBundle("submission-1")
      expect(bundle).toEqual({ submission: expect.objectContaining({ id: "submission-1" }) })
    })

    it("returns undefined for a missing submission bundle", async () => {
      expect(await getWorkSubmissionBundle("nope")).toBeUndefined()
    })

    it("reads a frozen input batch by submission", async () => {
      await getDb().workInputBatches.put(inputBatch())
      expect((await getWorkInputBatch("submission-1"))?.digest).toBe("wsv1-input")
    })
  })

  describe("retention and cascade", () => {
    it("drops only payloads whose expiry has passed", async () => {
      await seed()
      await getDb().workInputBatches.bulkPut([
        inputBatch(),
        inputBatch({ id: "batch-2", submissionId: "submission-2", expiresAt: NOW + 10_000 }),
      ])
      await getDb().executionContextBundles.put(contextBundle())

      const removed = await pruneExpiredWorkSubmissionPayloads(NOW + 5_000)
      expect(removed).toBe(2)
      expect((await getDb().workInputBatches.toArray()).map((row) => row.id)).toEqual(["batch-2"])
      expect(await getDb().executionContextBundles.count()).toBe(0)
    })

    it("leaves the submission row in place, because it is the audit trail", async () => {
      await seed()
      await getDb().workInputBatches.put(inputBatch())
      await pruneExpiredWorkSubmissionPayloads(NOW + 5_000)
      expect(await getWorkSubmission("submission-1")).toBeDefined()
    })

    it("reports zero when nothing has expired", async () => {
      await getDb().workInputBatches.put(inputBatch({ expiresAt: NOW + 10_000 }))
      expect(await pruneExpiredWorkSubmissionPayloads(NOW)).toBe(0)
    })
  })

  describe("toExecutionContextRef", () => {
    it("projects a stored bundle onto the shared contract shape", () => {
      expect(toExecutionContextRef(contextBundle())).toEqual({
        contextBundleId: "bundle-1",
        digest: "wsv1-context",
        projectId: "project-1",
        workspaceBindingRef: "workspace-main",
        baseRef: "refs/heads/dev",
      })
    })

    it("omits absent optional refs instead of emitting undefined keys", () => {
      const row = contextBundle()
      delete row.projectId
      delete row.workspaceBindingRef
      delete row.baseRef
      expect(toExecutionContextRef(row)).toEqual({
        contextBundleId: "bundle-1",
        digest: "wsv1-context",
      })
    })
  })
})
