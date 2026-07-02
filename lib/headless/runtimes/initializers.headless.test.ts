/**
 * Headless smoke for the boot-initializer batch (ADR-0059 T-A7..A9): every
 * registered runtime must start (and tear down) in a pure-Node process with
 * the fake-indexeddb shim — no DOM, no Tauri.
 *
 * @jest-environment node
 */
import { installFakeIndexedDb } from "../node-indexeddb"
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext, RuntimeBridge } from "../types"

const EXPECTED = [
  "scheduler",
  "workflow-runtime",
  "agent-team-runtime",
  "automation-policy",
  "audit-retention",
  "storage-retention",
  "routing-runtime",
  "background-task",
  "provider-cost-mirror",
]

function makeCtx(): HeadlessRuntimeContext {
  const bridge: RuntimeBridge = {
    listen: async () => () => undefined,
    invoke: async () => null,
  }
  return {
    host: "brain",
    accountId: "local_acct_a",
    bridge,
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log: () => undefined,
  }
}

describe("initializer batch headless smoke", () => {
  it("starts and stops every batch runtime in Node", async () => {
    await installFakeIndexedDb()
    __resetHeadlessRuntimesForTesting()
    await import("./initializers")

    const result = await bootstrapHeadlessRuntimes(makeCtx())
    const failures = result.failed.map(
      (f) => `${f.name}: ${f.error instanceof Error ? f.error.message : String(f.error)}`
    )
    expect(failures).toEqual([])
    for (const name of EXPECTED) {
      expect(result.started).toContain(name)
    }

    await result.stop()
  }, 60_000)
})
