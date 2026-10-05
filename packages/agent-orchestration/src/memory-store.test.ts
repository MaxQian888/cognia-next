import { createMemoryTeamRunStore } from "./memory-store"
import {
  TEAM_RUN_STORE_CONTRACT,
  contractChild,
  contractRun,
  type StoreContractAssert,
} from "./store-contract"

const assert: StoreContractAssert = {
  equal: (actual, expected) => expect(actual).toEqual(expected),
  ok: (value, message) =>
    expect({ value: Boolean(value), message }).toEqual({ value: true, message }),
  rejects: async (promise, message) => {
    await expect(promise).rejects.toThrow(message)
  },
}

describe("memory TeamRunStore satisfies the store contract", () => {
  for (const contractCase of TEAM_RUN_STORE_CONTRACT) {
    it(contractCase.name, () => contractCase.run(createMemoryTeamRunStore(), assert))
  }
})

describe("memory TeamRunStore isolation", () => {
  it("hands out copies so callers cannot mutate stored rows", async () => {
    const store = createMemoryTeamRunStore()
    await store.createRun(contractRun())
    const run = (await store.getRun("run-1"))!
    run.status = "failed"
    expect((await store.getRun("run-1"))?.status).toBe("running")
  })

  it("queues calls on the store behind an atomic block", async () => {
    const store = createMemoryTeamRunStore()
    await store.createRun(contractRun())
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const block = store.atomically(async (tx) => {
      await gate
      await tx.updateRun("run-1", { status: "paused", updatedAt: 2 })
    })
    const read = store.getRun("run-1")
    release()
    await block
    expect((await read)?.status).toBe("paused")
  })

  it("keeps launch constraints opaque and typed by the host", async () => {
    const store = createMemoryTeamRunStore<{ origin: string }>()
    await store.createRun({ ...contractRun(), executionConstraints: { origin: "im" } })
    expect((await store.getRun("run-1"))?.executionConstraints?.origin).toBe("im")
    await store.createChild(contractChild())
    expect(await store.listChildren("run-1")).toHaveLength(1)
  })
})
