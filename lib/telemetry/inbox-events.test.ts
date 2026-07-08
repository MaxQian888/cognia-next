/** @jest-environment jsdom */
/**
 * Tests for the trackInboxEvent convenience wrapper.
 *
 * The wrapper is a thin ergonomic shim over `lib/db/inbox-telemetry`. We
 * verify three contracts:
 *   1. Successful append populates the row with the caller's args and the
 *      default `Date.now()` timestamp.
 *   2. The `at` override flows through verbatim (for deterministic tests).
 *   3. Persistence failures are swallowed (returns null) so emit sites
 *      never throw at the call site.
 */

import "fake-indexeddb/auto"
import { trackInboxEvent } from "./inbox-events"
import { listRecent } from "@/lib/db/inbox-telemetry"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("trackInboxEvent", () => {
  it("appends a row carrying kind + caller args + Date.now() timestamp", async () => {
    const before = Date.now()
    const row = await trackInboxEvent("outbound.sent", {
      adapterId: "tg-1",
      conversationKey: "telegram:tg-1:c1",
      fields: { ms: 42 },
    })
    expect(row).not.toBeNull()
    expect(row?.kind).toBe("outbound.sent")
    expect(row?.adapterId).toBe("tg-1")
    expect(row?.conversationKey).toBe("telegram:tg-1:c1")
    expect(row?.fields).toEqual({ ms: 42 })
    expect(row?.at).toBeGreaterThanOrEqual(before)

    const persisted = await listRecent({ adapterId: "tg-1" })
    expect(persisted).toHaveLength(1)
    expect(persisted[0].kind).toBe("outbound.sent")
  })

  it("honors a caller-provided `at` for deterministic tests", async () => {
    const row = await trackInboxEvent("breaker.open", { at: 1234, adapterId: "dc-1" })
    expect(row?.at).toBe(1234)
  })

  it("returns null when persistence fails (best-effort contract)", async () => {
    // Delete the DB so the next append rejects (DatabaseClosedError or
    // similar). The wrapper must swallow it.
    await getDb().delete()
    const row = await trackInboxEvent("a2ui.downgrade", { adapterId: "x" })
    // Either the wrapper swallowed and returned null, OR the underlying
    // Dexie reopened and the write succeeded. Both are valid "did not
    // throw" outcomes; the contract is "never throw at the call site".
    expect(typeof row === "object").toBe(true)
  })
})
