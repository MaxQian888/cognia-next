import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { handleWorkflowFanoutCallback } from "./workflow-fanout-handler"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

async function seedBindingPair() {
  const adapterId = "lark:a"
  const surfaceId = "wffanout:abc"
  const conversationKey = "lark:lark:a:oc_demo"
  const payload = {
    workflowId: "wf_x",
    workflowName: "Deploy Pipeline",
    target: { adapterId, conversationKey },
    createdBy: "claude-tool",
  }
  await recordCallbackBinding({
    adapterId,
    actionId: "wffanoutapp:abc",
    kind: "wf_fanout_approve",
    surfaceId,
    componentId: "approve",
    conversationKey,
    payload,
  })
  await recordCallbackBinding({
    adapterId,
    actionId: "wffanoutcan:abc",
    kind: "wf_fanout_cancel",
    surfaceId,
    componentId: "cancel",
    conversationKey,
    payload,
  })
  return { adapterId, surfaceId, conversationKey }
}

describe("handleWorkflowFanoutCallback", () => {
  it("approve path writes the fan-out subscription + drops both bindings + sends confirmation", async () => {
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair()
    const approveBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wffanoutapp:abc"])
      .first())!

    await handleWorkflowFanoutCallback({
      binding: approveBinding,
      cancelled: false,
      adapterId,
      platform: "lark",
      conversationKey,
    })

    const subs = await getDb().workflowFanoutSubscriptions.toArray()
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({
      workflowId: "wf_x",
      adapterId,
      conversationKey,
      enabled: true,
      createdBy: "claude-tool",
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("Deploy Pipeline")
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已订阅")

    const remaining = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(remaining).toHaveLength(0)
  })

  it("cancel path skips the subscription write + sends cancellation", async () => {
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair()
    const cancelBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wffanoutcan:abc"])
      .first())!

    await handleWorkflowFanoutCallback({
      binding: cancelBinding,
      cancelled: true,
      adapterId,
      platform: "lark",
      conversationKey,
    })

    expect(await getDb().workflowFanoutSubscriptions.toArray()).toHaveLength(0)
    const jobs = await getDb().outboundQueue.toArray()
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已取消")
    const remaining = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(remaining).toHaveLength(0)
  })

  it("idempotent on re-approve — second approve refreshes updatedAt without duplicating", async () => {
    const { adapterId, conversationKey } = await seedBindingPair()
    const approve = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wffanoutapp:abc"])
      .first())!

    await handleWorkflowFanoutCallback({
      binding: approve,
      cancelled: false,
      adapterId,
      platform: "lark",
      conversationKey,
    })
    // Re-seed for a second tap (the first call wiped the bindings).
    await seedBindingPair()
    const approve2 = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wffanoutapp:abc"])
      .first())!
    await handleWorkflowFanoutCallback({
      binding: approve2,
      cancelled: false,
      adapterId,
      platform: "lark",
      conversationKey,
    })

    const subs = await getDb().workflowFanoutSubscriptions.toArray()
    expect(subs).toHaveLength(1)
  })

  it("silently cleans up when the binding payload is malformed", async () => {
    const adapterId = "lark:a"
    const surfaceId = "wffanout:bad"
    await recordCallbackBinding({
      adapterId,
      actionId: "wffanoutapp:bad",
      kind: "wf_fanout_approve",
      surfaceId,
      payload: { broken: true } as never,
    })
    const binding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wffanoutapp:bad"])
      .first())!

    await handleWorkflowFanoutCallback({
      binding,
      cancelled: false,
      adapterId,
      platform: "lark",
      conversationKey: "lark:lark:a:oc_demo",
    })

    expect(await getDb().workflowFanoutSubscriptions.toArray()).toHaveLength(0)
    expect(await getDb().outboundQueue.toArray()).toHaveLength(0)
    expect(
      await getDb().connectorCallbackBindings.where("adapterId").equals(adapterId).toArray()
    ).toHaveLength(0)
  })
})
