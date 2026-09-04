import { EXECUTOR_PRIMARY_ACTION, isInAppExecutor } from "@cognia/agent-config-types"

import type { UpdateAdapter, UpdateItem } from "./adapter"

/**
 * The contract is types-only, so what is worth pinning is that a conforming
 * adapter compiles and that the row projection stays consistent with the
 * executor vocabulary it is derived from.
 */
const adapter: UpdateAdapter = {
  kind: "plugin",
  executor: "plugin-runtime",
  isSupported: () => true,
  check: async () => [],
  apply: async () => ({ state: "verified" }),
}

describe("UpdateAdapter", () => {
  it("answers an empty check as everything current", async () => {
    expect(
      await adapter.check({ channel: "stable", rolloutBucket: 0, manual: false, catalog: null })
    ).toEqual([])
  })

  it("requires every adapter to implement apply, including store-backed ones", async () => {
    const store: UpdateAdapter = {
      kind: "mobile-ios",
      executor: "app-store",
      isSupported: () => false,
      check: async () => [],
      apply: async () => ({ state: "awaiting-store" }),
    }
    expect((await store.apply({} as never, { consented: true })).state).toBe("awaiting-store")
  })
})

describe("UpdateItem", () => {
  it("derives externallyInstalled from the executor, not from the asset kind", () => {
    const row: UpdateItem = {
      key: "mobile-ios:app",
      assetId: "app",
      kind: "mobile-ios",
      executor: "app-store",
      state: "available",
      candidate: null,
      currentVersion: "1.0.0",
      action: EXECUTOR_PRIMARY_ACTION["app-store"],
      externallyInstalled: !isInAppExecutor("app-store"),
    }
    expect(row.externallyInstalled).toBe(true)
    expect(row.action).toBe("open-store")
  })
})
