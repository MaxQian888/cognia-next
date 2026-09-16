/** @jest-environment jsdom */
import "fake-indexeddb/auto"

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ name: "deps-test-main" }),
}))

import { __resetFusionDbForTesting } from "../db/fusion-db"
import { accountDatabaseAppliers } from "../db/outbox-appliers"
import { chatRunDeps, windowLeaseOwner } from "./chat-run-deps"
import { __resetFusionStoreForTesting } from "./store-provider"

describe("chatRunDeps", () => {
  afterEach(() => {
    __resetFusionStoreForTesting()
    __resetFusionDbForTesting()
  })

  it("gives every run of this window one lease owner, the account store and its appliers", async () => {
    const faults: string[] = []
    const deps = chatRunDeps((fault) => faults.push(fault.code))
    expect(deps.leaseOwner).toBe(windowLeaseOwner())
    expect(deps.leaseOwner).toMatch(/^window:[0-9a-f-]{36}$/)
    expect(chatRunDeps(() => undefined).leaseOwner).toBe(deps.leaseOwner)
    expect(deps.appliers).toBe(accountDatabaseAppliers)
    expect((await deps.store()).db.name).toBe("deps-test-main-router-fusion-v1")
    deps.onFault?.({ code: "internal" } as never)
    expect(faults).toEqual(["internal"])
  })
})
