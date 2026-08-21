import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createWorkflow } from "@/lib/db/workflows"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { publishWorkflowLifecycle } from "@/lib/workflow/publish/publication-lifecycle"
import { handleWorkflowApprovalCallback } from "./workflow-approval-handler"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
})

async function seedBindingPair(
  workflowId: string,
  workflowName: string,
  extra: Record<string, unknown> = {}
) {
  const adapterId = "wecom:a"
  const surfaceId = "wfsurf:abc"
  const conversationKey = "wecom:wecom:a:room"
  const payload = {
    workflowId,
    workflowName,
    runParams: { x: 1 },
    triggeredFrom: {
      source: "im" as const,
      adapterId,
      conversationKey,
      sessionId: "s1",
    },
    ...extra,
  }
  await recordCallbackBinding({
    adapterId,
    actionId: "wfapp:abc",
    kind: "wf_approve",
    surfaceId,
    componentId: "approve",
    conversationKey,
    payload,
  })
  await recordCallbackBinding({
    adapterId,
    actionId: "wfcan:abc",
    kind: "wf_cancel",
    surfaceId,
    componentId: "cancel",
    conversationKey,
    payload,
  })
  return { adapterId, surfaceId, conversationKey }
}

afterAll(dbFixture.dispose)

describe("handleWorkflowApprovalCallback", () => {
  it("approve path starts the workflow + enqueues a confirmation + deletes bindings", async () => {
    const wf = await createWorkflow({ name: "Daily Standup" })
    // `executeDeployedWorkflow` is a FORMAL invocation: it resolves a published
    // production deployment and refuses with `deployment-not-found` when there
    // is none. A workflow that was only created has never been published, so
    // without this the approve path takes the not-found branch and asserts
    // nothing about approving.
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair(wf.id, "Daily Standup")
    const approveBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: approveBinding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect(jobs[0].source).toBe("workflow")
    const seg = jobs[0].request.segments[0] as { type: string; text: string }
    expect(seg.type).toBe("text")
    expect(seg.text).toContain("Daily Standup")
    expect(seg.text).toContain("已启动")

    const runs = await getDb().workflowRuns.toArray()
    expect(runs.find((r) => r.workflowId === wf.id)).toBeDefined()

    const bindings = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(bindings).toHaveLength(0)
  })

  it("carries the frozen permission ceiling into the approved run", async () => {
    // The card can sit unanswered for hours. Re-deriving the ceiling at press
    // time would let a policy change between the ask and the answer widen the
    // run that was actually approved, so the binding carries it verbatim.
    const wf = await createWorkflow({ name: "Deploy" })
    await publishWorkflowLifecycle(wf.id, Date.now())
    const { adapterId, conversationKey } = await seedBindingPair(wf.id, "Deploy", {
      permissionCeiling: { allowedTools: ["Read"], permissionMode: "default" },
    })
    const approveBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: approveBinding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    const run = (await getDb().workflowRuns.toArray()).find((r) => r.workflowId === wf.id)
    expect(run?.securityContext?.permissionCeiling).toEqual({
      allowedTools: ["Read"],
      permissionMode: "default",
    })
  })

  it("cancel path enqueues a cancellation + deletes bindings + does NOT create a run", async () => {
    const wf = await createWorkflow({ name: "Daily Standup" })
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair(wf.id, "Daily Standup")
    const cancelBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfcan:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: cancelBinding,
      cancelled: true,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("已取消")

    const runs = await getDb().workflowRuns.toArray()
    expect(runs.find((r) => r.workflowId === wf.id)).toBeUndefined()

    const bindings = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(bindings).toHaveLength(0)
  })

  it("emits an error message when the workflow no longer exists", async () => {
    const { adapterId, surfaceId, conversationKey } = await seedBindingPair("wf_missing", "Ghost")
    const approveBinding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:abc"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding: approveBinding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey,
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(1)
    expect((jobs[0].request.segments[0] as { text: string }).text).toContain("无法启动")
    const bindings = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .filter((b) => b.surfaceId === surfaceId)
      .toArray()
    expect(bindings).toHaveLength(0)
  })

  it("silently cleans up when the binding payload is malformed", async () => {
    const adapterId = "wecom:a"
    const surfaceId = "wfsurf:bad"
    await recordCallbackBinding({
      adapterId,
      actionId: "wfapp:bad",
      kind: "wf_approve",
      surfaceId,
      payload: { bogus: true } as never,
    })
    const binding = (await getDb()
      .connectorCallbackBindings.where("[adapterId+actionId]")
      .equals([adapterId, "wfapp:bad"])
      .first())!

    await handleWorkflowApprovalCallback({
      binding,
      cancelled: false,
      adapterId,
      platform: "wecom",
      conversationKey: "wecom:wecom:a:room",
    })

    const jobs = await getDb().outboundQueue.toArray()
    expect(jobs).toHaveLength(0)
    const remaining = await getDb()
      .connectorCallbackBindings.where("adapterId")
      .equals(adapterId)
      .toArray()
    expect(remaining).toHaveLength(0)
  })
})
