/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import {
  DEFAULT_LEASE_TTL_MS,
  claimRunLease,
  getExecutorId,
  releaseRunLease,
  renewRunLease,
  startLeaseHeartbeat,
  stopLeaseHeartbeat,
  __resetRunLeaseForTesting,
} from "./run-lease"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import type { WorkflowRunRow } from "@/types/workflow/visual"

jest.setTimeout(30_000)

function runRow(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "run_lease",
    workflowId: "wf_1",
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 1,
    workflowSnapshot: {} as WorkflowRunRow["workflowSnapshot"],
    ...overrides,
  }
}

beforeAll(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

beforeEach(async () => {
  __resetRunLeaseForTesting()
  await getDb().workflowRuns.clear()
  await getDb().workflowRuns.put(runRow())
})

afterEach(() => __resetRunLeaseForTesting())

describe("executor identity", () => {
  it("is stable within a process and prefixed", () => {
    const id = getExecutorId()
    expect(id).toMatch(/^exec_/)
    expect(getExecutorId()).toBe(id)
  })
})

describe("claimRunLease", () => {
  it("claims a lease-free run and stamps expiry", async () => {
    expect(await claimRunLease("run_lease", { nowMs: 1_000 })).toBe("claimed")
    const row = await getDb().workflowRuns.get("run_lease")
    expect(row?.lease).toMatchObject({
      ownerId: getExecutorId(),
      claimedAt: 1_000,
      expiresAt: 1_000 + DEFAULT_LEASE_TTL_MS,
    })
  })

  it("re-claims its own lease (idempotent) preserving claimedAt", async () => {
    await claimRunLease("run_lease", { nowMs: 1_000 })
    expect(await claimRunLease("run_lease", { nowMs: 5_000 })).toBe("claimed")
    const row = await getDb().workflowRuns.get("run_lease")
    expect(row?.lease?.claimedAt).toBe(1_000)
    expect(row?.lease?.expiresAt).toBe(5_000 + DEFAULT_LEASE_TTL_MS)
  })

  it("refuses a live lease held by another executor, claims a stale one", async () => {
    await claimRunLease("run_lease", { ownerId: "exec_other", nowMs: 1_000 })
    expect(await claimRunLease("run_lease", { nowMs: 2_000 })).toBe("held")
    // Past the other executor's expiry the claim goes through.
    expect(await claimRunLease("run_lease", { nowMs: 1_000 + DEFAULT_LEASE_TTL_MS + 1 })).toBe(
      "claimed"
    )
  })

  it("reports not-found for unknown runs", async () => {
    expect(await claimRunLease("run_ghost")).toBe("not-found")
  })
})

describe("renew / release", () => {
  it("renews only while owning", async () => {
    await claimRunLease("run_lease", { nowMs: 1_000 })
    expect(await renewRunLease("run_lease", { nowMs: 10_000 })).toBe(true)
    expect((await getDb().workflowRuns.get("run_lease"))?.lease?.expiresAt).toBe(
      10_000 + DEFAULT_LEASE_TTL_MS
    )
    expect(await renewRunLease("run_lease", { ownerId: "exec_other" })).toBe(false)
  })

  it("release drops the lease only for the owner and is idempotent", async () => {
    await claimRunLease("run_lease")
    await releaseRunLease("run_lease", "exec_other")
    expect((await getDb().workflowRuns.get("run_lease"))?.lease).toBeDefined()
    await releaseRunLease("run_lease")
    expect((await getDb().workflowRuns.get("run_lease"))?.lease).toBeUndefined()
    await releaseRunLease("run_lease")
  })
})

describe("lease heartbeat", () => {
  it("renews on a cadence and fires onCancelRequested when stamped", async () => {
    await claimRunLease("run_lease")
    const onCancel = jest.fn()
    // ttl 3s → beat every 1s.
    startLeaseHeartbeat("run_lease", { ttlMs: 3_000, onCancelRequested: onCancel })
    await getDb().workflowRuns.update("run_lease", { cancelRequestedAt: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    expect(onCancel).toHaveBeenCalled()
    stopLeaseHeartbeat("run_lease")
  })

  it("stop is idempotent and replaces a prior heartbeat for the run", async () => {
    await claimRunLease("run_lease")
    const stop = startLeaseHeartbeat("run_lease", { ttlMs: 3_000 })
    startLeaseHeartbeat("run_lease", { ttlMs: 3_000 })
    stop()
    stopLeaseHeartbeat("run_lease")
  })
})
