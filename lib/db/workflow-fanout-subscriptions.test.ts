import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"
import {
  __subscriptionIdForTesting,
  createFanoutSubscription,
  deleteFanoutSubscription,
  deleteSubscriptionsForWorkflow,
  listForChannel,
  listForWorkflow,
  setSubscriptionEnabled,
} from "./workflow-fanout-subscriptions"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})
afterAll(dbFixture.dispose)

describe("createFanoutSubscription", () => {
  it("writes a fresh row keyed by (workflowId, adapterId, conversationKey)", async () => {
    const row = await createFanoutSubscription({
      workflowId: "wf_1",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:oc_demo",
      createdBy: "settings-ui",
    })
    expect(row.id).toBe(
      __subscriptionIdForTesting({
        workflowId: "wf_1",
        adapterId: "lark:a",
        conversationKey: "lark:lark:a:oc_demo",
      })
    )
    expect(row.enabled).toBe(true)
    expect(row.createdBy).toBe("settings-ui")
    const stored = await getDb().workflowFanoutSubscriptions.get(row.id)
    expect(stored).toBeDefined()
  })

  it("is idempotent on the (workflow, adapter, conversation) triple — refreshes updatedAt + enabled", async () => {
    const first = await createFanoutSubscription({
      workflowId: "wf_1",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:oc_demo",
      enabled: true,
      createdBy: "settings-ui",
    })
    await new Promise((r) => setTimeout(r, 5))
    const second = await createFanoutSubscription({
      workflowId: "wf_1",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:oc_demo",
      enabled: false,
      // A later write keeps the ORIGINAL createdBy — the row only ever
      // remembers who first created it. updatedAt advances to "now".
      createdBy: "claude-tool",
    })
    expect(second.id).toBe(first.id)
    expect(second.createdBy).toBe("settings-ui")
    expect(second.enabled).toBe(false)
    expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)
    expect((await getDb().workflowFanoutSubscriptions.toArray()).length).toBe(1)
  })
})

describe("listForWorkflow", () => {
  it("returns only enabled rows by default", async () => {
    const on = await createFanoutSubscription({
      workflowId: "wf",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    const off = await createFanoutSubscription({
      workflowId: "wf",
      adapterId: "wecom:b",
      conversationKey: "wecom:wecom:b:c2",
      enabled: false,
      createdBy: "settings-ui",
    })
    const live = await listForWorkflow("wf")
    expect(live.map((r) => r.id)).toEqual([on.id])
    const all = await listForWorkflow("wf", { includeDisabled: true })
    expect(all.map((r) => r.id).sort()).toEqual([on.id, off.id].sort())
  })

  it("scopes by workflowId so other workflows don't leak in", async () => {
    await createFanoutSubscription({
      workflowId: "wf_target",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    await createFanoutSubscription({
      workflowId: "wf_unrelated",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    const live = await listForWorkflow("wf_target")
    expect(live).toHaveLength(1)
    expect(live[0].workflowId).toBe("wf_target")
  })
})

describe("setSubscriptionEnabled / deleteFanoutSubscription", () => {
  it("toggle flips the enabled bit + bumps updatedAt", async () => {
    const row = await createFanoutSubscription({
      workflowId: "wf",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    await new Promise((r) => setTimeout(r, 5))
    await setSubscriptionEnabled(row.id, false)
    const after = await getDb().workflowFanoutSubscriptions.get(row.id)
    expect(after?.enabled).toBe(false)
    expect(after?.updatedAt).toBeGreaterThanOrEqual(row.updatedAt)
  })

  it("delete removes the row entirely", async () => {
    const row = await createFanoutSubscription({
      workflowId: "wf",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    await deleteFanoutSubscription(row.id)
    expect(await getDb().workflowFanoutSubscriptions.get(row.id)).toBeUndefined()
  })
})

describe("deleteSubscriptionsForWorkflow", () => {
  it("drops every row for the workflow and returns the count", async () => {
    await createFanoutSubscription({
      workflowId: "wf_kill",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    await createFanoutSubscription({
      workflowId: "wf_kill",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c2",
      createdBy: "settings-ui",
    })
    await createFanoutSubscription({
      workflowId: "wf_keep",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    const dropped = await deleteSubscriptionsForWorkflow("wf_kill")
    expect(dropped).toBe(2)
    expect(await listForWorkflow("wf_kill", { includeDisabled: true })).toHaveLength(0)
    expect(await listForWorkflow("wf_keep", { includeDisabled: true })).toHaveLength(1)
  })

  it("returns 0 when no rows match", async () => {
    expect(await deleteSubscriptionsForWorkflow("wf_nonexistent")).toBe(0)
  })
})

describe("listForChannel", () => {
  it("returns every subscription mirroring INTO the given channel", async () => {
    await createFanoutSubscription({
      workflowId: "wf_a",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    await createFanoutSubscription({
      workflowId: "wf_b",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:c1",
      createdBy: "settings-ui",
    })
    await createFanoutSubscription({
      workflowId: "wf_c",
      adapterId: "lark:a",
      conversationKey: "lark:lark:a:elsewhere",
      createdBy: "settings-ui",
    })
    const rows = await listForChannel("lark:a", "lark:lark:a:c1")
    expect(rows.map((r) => r.workflowId).sort()).toEqual(["wf_a", "wf_b"])
  })
})
