import { createDbTestFixture } from "./test-fixture"
import {
  awaitMemoryOperation,
  findMemoryOperation,
  memoryOperationRequestHash,
  MEMORY_OPERATION_PENDING,
  recordMemoryOperation,
  releaseMemoryOperation,
  reserveMemoryOperation,
  runMemoryMutation,
  type MemoryOperationBinding,
} from "./memory-operations"
import { createMemory, getMemory } from "./memories"
import { getDb } from "./schema"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function seen() {
  return {
    scope: "global" as const,
    projectId: undefined,
    characterId: undefined,
    agentId: undefined,
  }
}

async function seedMemory(id = "m1") {
  return createMemory({
    id,
    scope: "global",
    type: "semantic",
    text: "fact",
    importance: 5,
    provenance: "user",
    evidenceState: "legacy",
    reviewStatus: "unreviewed",
    contaminationState: "unknown",
    sensitivity: "unknown",
  })
}

function binding(overrides: Partial<MemoryOperationBinding> = {}): MemoryOperationBinding {
  return {
    principalId: "plugin:demo",
    operationId: "op-1",
    requestHash: "hash-a",
    kind: "update",
    ...overrides,
  }
}

describe("runMemoryMutation", () => {
  it("applies the patch, bumps the version, and writes audit + receipt in one go", async () => {
    await seedMemory()
    const outcome = await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      operation: binding(),
      apply: () => ({
        patch: { text: "updated" },
        audits: [{ action: "revised", reason: "external" }],
      }),
    })
    expect(outcome).toEqual({ ok: true, version: 2 })
    const row = await getMemory("m1")
    expect(row).toMatchObject({ text: "updated", version: 2 })
    const receipt = await findMemoryOperation("plugin:demo", "op-1")
    expect(receipt).toMatchObject({
      kind: "update",
      requestHash: "hash-a",
      memoryId: "m1",
      resultCode: "ok",
      resultVersion: 2,
    })
    const audits = await getDb().memoryAuditEvents.where("memoryId").equals("m1").toArray()
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({ action: "revised", reason: "external" })
  })

  it("replays a recorded receipt for an identical request instead of re-applying", async () => {
    await seedMemory()
    const apply = jest.fn(() => ({ patch: { text: "updated" } }))
    await runMemoryMutation({ memoryId: "m1", seen: seen(), operation: binding(), apply })
    apply.mockClear()
    const replay = await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      operation: binding(),
      apply,
    })
    expect(replay).toEqual({ ok: true, version: 2 })
    expect(apply).not.toHaveBeenCalled()
    // And the row was not bumped a second time.
    expect((await getMemory("m1"))?.version).toBe(2)
  })

  it("refuses the same operation id carrying a different request", async () => {
    await seedMemory()
    await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      operation: binding(),
      apply: () => ({ patch: { text: "updated" } }),
    })
    const outcome = await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      operation: binding({ requestHash: "hash-b" }),
      apply: () => ({ patch: { text: "other" } }),
    })
    expect(outcome).toEqual({ ok: false, reason: "idempotency_key_reused" })
  })

  it("reports not_found and writes no receipt for a missing row", async () => {
    const outcome = await runMemoryMutation({
      memoryId: "ghost",
      seen: seen(),
      operation: binding(),
      apply: () => ({ patch: { text: "x" } }),
    })
    expect(outcome).toEqual({ ok: false, reason: "not_found" })
    // Denied/conflicted requests leave no receipt — a retry must evaluate fresh.
    expect(await findMemoryOperation("plugin:demo", "op-1")).toBeUndefined()
  })

  it("rejects a stale expectedVersion without a receipt", async () => {
    await seedMemory()
    const outcome = await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      expectedVersion: 9,
      operation: binding(),
      apply: () => ({ patch: { text: "x" } }),
    })
    expect(outcome).toEqual({ ok: false, reason: "version_conflict", currentVersion: 1 })
    expect(await findMemoryOperation("plugin:demo", "op-1")).toBeUndefined()
  })

  it("rejects a write against a row that moved namespaces since the read", async () => {
    await seedMemory()
    const outcome = await runMemoryMutation({
      memoryId: "m1",
      seen: { ...seen(), projectId: "p-old" },
      apply: () => ({ patch: { text: "x" } }),
    })
    expect(outcome).toEqual({ ok: false, reason: "version_conflict", currentVersion: 1 })
  })

  it("treats an empty patch as a true no-op — no bump, no updatedAt stamp", async () => {
    const created = await seedMemory()
    const outcome = await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      operation: binding({ kind: "forget" }),
      apply: () => ({ patch: {} }),
    })
    expect(outcome).toEqual({ ok: true, version: 1 })
    const row = await getMemory("m1")
    expect(row?.version).toBe(1)
    expect(row?.updatedAt).toBe(created.updatedAt)
    // The receipt still records the operation so a replay stays idempotent.
    expect(await findMemoryOperation("plugin:demo", "op-1")).toMatchObject({
      resultCode: "ok",
      resultVersion: 1,
    })
  })

  it("applies over a pending marker from a store reservation on the same key", async () => {
    await seedMemory()
    const first = await reserveMemoryOperation(binding({ kind: "store" }))
    expect(first.state).toBe("reserved")
    const outcome = await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      operation: binding({ kind: "store" }),
      apply: () => ({ patch: { text: "stored" } }),
    })
    expect(outcome).toEqual({ ok: true, version: 2 })
    // Our recorded receipt replaces the marker.
    expect(await findMemoryOperation("plugin:demo", "op-1")).toMatchObject({
      resultCode: "ok",
      resultVersion: 2,
    })
  })

  it("applies unconditionally when neither guard is supplied", async () => {
    await seedMemory()
    const outcome = await runMemoryMutation({
      memoryId: "m1",
      seen: seen(),
      apply: () => ({ patch: { text: "legacy" } }),
    })
    expect(outcome).toEqual({ ok: true, version: 2 })
    expect(await getDb().memoryOperations.count()).toBe(0)
  })
})

describe("reserveMemoryOperation", () => {
  it("claims an unseen key with a pending marker", async () => {
    expect(await reserveMemoryOperation(binding())).toEqual({ state: "reserved" })
    expect(await findMemoryOperation("plugin:demo", "op-1")).toMatchObject({
      resultCode: MEMORY_OPERATION_PENDING,
    })
  })

  it("reports in_flight when an identical request is applying elsewhere", async () => {
    await reserveMemoryOperation(binding())
    expect(await reserveMemoryOperation(binding())).toEqual({ state: "in_flight" })
  })

  it("replays a settled receipt for an identical request", async () => {
    await recordMemoryOperation({
      id: "plugin:demo:op-1",
      principalId: "plugin:demo",
      operationId: "op-1",
      kind: "update",
      requestHash: "hash-a",
      memoryId: "m1",
      resultCode: "ok",
      resultVersion: 4,
      createdAt: 1,
    })
    const reservation = await reserveMemoryOperation(binding())
    expect(reservation.state).toBe("replay")
    if (reservation.state === "replay") {
      expect(reservation.receipt.resultVersion).toBe(4)
    }
  })

  it("conflicts on the same id with a different request hash", async () => {
    await reserveMemoryOperation(binding())
    expect(await reserveMemoryOperation(binding({ requestHash: "hash-b" }))).toEqual({
      state: "conflict",
    })
  })

  it("namespaces the same operation id per principal", async () => {
    await reserveMemoryOperation(binding())
    expect(await reserveMemoryOperation(binding({ principalId: "mcp:other" }))).toEqual({
      state: "reserved",
    })
  })
})

describe("releaseMemoryOperation", () => {
  it("frees a pending marker so a corrected retry can proceed", async () => {
    await reserveMemoryOperation(binding())
    await releaseMemoryOperation("plugin:demo", "op-1", "hash-a")
    expect(await findMemoryOperation("plugin:demo", "op-1")).toBeUndefined()
    expect(await reserveMemoryOperation(binding())).toEqual({ state: "reserved" })
  })

  it("never deletes a settled receipt", async () => {
    await recordMemoryOperation({
      id: "plugin:demo:op-1",
      principalId: "plugin:demo",
      operationId: "op-1",
      kind: "update",
      requestHash: "hash-a",
      memoryId: "m1",
      resultCode: "ok",
      resultVersion: 2,
      createdAt: 1,
    })
    await releaseMemoryOperation("plugin:demo", "op-1", "hash-a")
    expect(await findMemoryOperation("plugin:demo", "op-1")).toMatchObject({ resultCode: "ok" })
  })

  it("never deletes a pending marker that belongs to a different request", async () => {
    await reserveMemoryOperation(binding())
    await releaseMemoryOperation("plugin:demo", "op-1", "hash-b")
    expect(await findMemoryOperation("plugin:demo", "op-1")).toMatchObject({
      resultCode: MEMORY_OPERATION_PENDING,
    })
  })
})

describe("awaitMemoryOperation", () => {
  it("returns the receipt once the in-flight operation settles", async () => {
    await reserveMemoryOperation(binding())
    const waiter = awaitMemoryOperation("plugin:demo", "op-1", { intervalMs: 5 })
    await recordMemoryOperation({
      id: "plugin:demo:op-1",
      principalId: "plugin:demo",
      operationId: "op-1",
      kind: "store",
      requestHash: "hash-a",
      memoryId: "m1",
      resultCode: "ok",
      resultVersion: 1,
      createdAt: 2,
    })
    await expect(waiter).resolves.toMatchObject({ resultCode: "ok" })
  })

  it("returns undefined when the wait times out", async () => {
    await reserveMemoryOperation(binding())
    await expect(
      awaitMemoryOperation("plugin:demo", "op-1", { timeoutMs: 20, intervalMs: 5 })
    ).resolves.toBeUndefined()
  })

  it("returns undefined promptly when the reservation is released rather than settled", async () => {
    await reserveMemoryOperation(binding())
    const started = Date.now()
    const waiter = awaitMemoryOperation("plugin:demo", "op-1", {
      timeoutMs: 10_000,
      intervalMs: 5,
    })
    await releaseMemoryOperation("plugin:demo", "op-1", "hash-a")
    await expect(waiter).resolves.toBeUndefined()
    // A disappeared marker means the writer failed and freed the key — the
    // wait must end there, not at the 10s deadline.
    expect(Date.now() - started).toBeLessThan(1_000)
  })
})

describe("memoryOperationRequestHash", () => {
  it("is stable across object key ordering", async () => {
    const a = await memoryOperationRequestHash("update", { text: "x", importance: 7 })
    const b = await memoryOperationRequestHash("update", { importance: 7, text: "x" })
    expect(a).toBe(b)
  })

  it("differs across kinds and payloads", async () => {
    const a = await memoryOperationRequestHash("update", { text: "x" })
    const b = await memoryOperationRequestHash("forget", { text: "x" })
    const c = await memoryOperationRequestHash("update", { text: "y" })
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  it("ignores undefined-valued fields like JSON.stringify would", async () => {
    const a = await memoryOperationRequestHash("update", { text: "x", extra: undefined })
    const b = await memoryOperationRequestHash("update", { text: "x" })
    expect(a).toBe(b)
  })
})
