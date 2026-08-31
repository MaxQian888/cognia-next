/** @jest-environment jsdom */
/**
 * These helpers exist so a plugin's suite never needs `getDb()`. The contract
 * worth pinning is what they write: a session with (or deliberately without) a
 * platform binding, and an inbound job in the `running` state — the two
 * preconditions the approval-scoping path reads.
 */

import { createDbTestFixture } from "@/lib/db/test-fixture"
import { getDb } from "@/lib/db/schema"
import { listCallbackBindings, seedPlatformBoundSession, seedRunningInboundJob } from "./testing"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("seedPlatformBoundSession", () => {
  it("writes a session with the binding an IM-originated run reads", async () => {
    await seedPlatformBoundSession({
      sessionId: "s1",
      binding: { adapterId: "wecom:a", conversationKey: "conv-1", platform: "wecom" },
    })
    const row = await getDb().sessions.get("s1")
    expect(row?.platformBinding).toMatchObject({
      adapterId: "wecom:a",
      conversationKey: "conv-1",
      platform: "wecom",
      conversationRef: { platform: "wecom", adapterId: "wecom:a" },
    })
  })

  it("omits the binding entirely when none is given — an editor-started run", async () => {
    await seedPlatformBoundSession({ sessionId: "s2" })
    const row = await getDb().sessions.get("s2")
    expect(row).toBeDefined()
    expect(row?.platformBinding).toBeUndefined()
  })
})

describe("seedRunningInboundJob", () => {
  it("leaves the job in `running` — a queued job is not driving a turn", async () => {
    const { id } = await seedRunningInboundJob({
      adapterId: "wecom:a",
      conversationKey: "conv-1",
      platform: "wecom",
      sender: { id: "wecom:u1", remoteUserId: "u1", displayName: "Ann" },
    })
    const row = await getDb().connectorInboundJobs.get(id)
    expect(row?.status).toBe("running")
    expect(row?.event.sender).toMatchObject({ remoteUserId: "u1", displayName: "Ann" })
    expect(row?.conversationKey).toBe("conv-1")
  })
})

describe("listCallbackBindings", () => {
  it("is empty on a fresh database rather than throwing", async () => {
    await expect(listCallbackBindings()).resolves.toEqual([])
  })

  it("reads back what the host recorded", async () => {
    const { recordCallbackBinding } = await import("@/lib/connectors/adapters/_shared/a2ui-mapper")
    await recordCallbackBinding({
      actionId: "wfapp:1",
      kind: "wf_approve",
      adapterId: "wecom:a",
      conversationKey: "conv-1",
      payload: {},
    } as never)
    const bindings = await listCallbackBindings()
    expect(bindings.map((b) => b.kind)).toContain("wf_approve")
  })
})
