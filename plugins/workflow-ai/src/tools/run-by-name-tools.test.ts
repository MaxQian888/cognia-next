/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"
import { buildRunByNameTools } from "./run-by-name-tools"

async function seedSession(opts: { sessionId: string; bindToIM?: boolean }): Promise<void> {
  const now = Date.now()
  await getDb().sessions.put({
    id: opts.sessionId,
    title: "Test",
    createdAt: now,
    updatedAt: now,
    characterId: undefined as never,
    ...(opts.bindToIM
      ? {
          platformBinding: {
            adapterId: "wecom:a",
            conversationKey: "wecom:wecom:a:room",
            platform: "wecom",
            conversationRef: { platform: "wecom", adapterId: "wecom:a" },
          },
        }
      : {}),
  })
}

const tools = buildRunByNameTools()
const listTool = tools.find((t) => t.name === "wf_list_workflows")!
const runByNameTool = tools.find((t) => t.name === "wf_run_workflow_by_name")!
const subscribeTool = tools.find((t) => t.name === "wf_subscribe_workflow_fanout")!

const ctx = (sessionId?: string) => ({
  sessionId,
  config: {},
})

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("wf_list_workflows", () => {
  it("returns id + name + description for every workflow up to limit", async () => {
    const a = await createWorkflow({ name: "Alpha", description: "the first" })
    const b = await createWorkflow({ name: "Beta" })
    const result = (await listTool.execute({}, ctx())) as {
      ok: boolean
      count: number
      workflows: Array<{ id: string; name: string; description?: string }>
    }
    expect(result.ok).toBe(true)
    expect(result.workflows.map((w) => w.id)).toEqual(expect.arrayContaining([a.id, b.id]))
    const alpha = result.workflows.find((w) => w.id === a.id)
    expect(alpha?.description).toBe("the first")
  })

  it("clamps limit to the documented range", async () => {
    for (let i = 0; i < 3; i++) await createWorkflow({ name: `WF ${i}` })
    const tooBig = (await listTool.execute({ limit: 9999 }, ctx())) as {
      workflows: unknown[]
    }
    expect(tooBig.workflows.length).toBeLessThanOrEqual(200)
    const sane = (await listTool.execute({ limit: 2 }, ctx())) as { workflows: unknown[] }
    expect(sane.workflows).toHaveLength(2)
  })
})

describe("wf_run_workflow_by_name", () => {
  it("rejects when the session has no IM binding", async () => {
    await seedSession({ sessionId: "s1", bindToIM: false })
    await createWorkflow({ name: "Anything" })
    const result = (await runByNameTool.execute({ name: "Anything" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("not-an-im-session")
  })

  it("rejects when the name is empty / whitespace", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const result = (await runByNameTool.execute({ name: "  " }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("invalid-name")
  })

  it("returns workflow-not-found with a list-tool hint", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const result = (await runByNameTool.execute({ name: "zeta-no-match" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string; message: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("workflow-not-found")
    expect(result.error?.message).toContain("wf_list_workflows")
  })

  it("returns workflow-ambiguous with candidate bullets", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    await createWorkflow({ name: "Report A" })
    await createWorkflow({ name: "Report B" })
    const result = (await runByNameTool.execute({ name: "report" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string; message: string; detail: { candidates: unknown[] } }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("workflow-ambiguous")
    expect(result.error?.detail.candidates).toHaveLength(2)
    expect(result.error?.message).toContain("Report A")
  })

  it("on success, returns surface + writes wf_approve / wf_cancel bindings", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const wf = await createWorkflow({
      name: "Daily Standup",
      description: "Runs every morning",
    })
    const result = (await runByNameTool.execute(
      { name: "Daily Standup", runParams: { focus: "today" } },
      ctx("s1")
    )) as {
      ok: boolean
      workflowId: string
      surface: { components: Record<string, unknown> }
      surfaceId: string
      instruction: string
    }
    expect(result.ok).toBe(true)
    expect(result.workflowId).toBe(wf.id)
    expect(result.surfaceId.startsWith("wfsurf:")).toBe(true)
    const approve = result.surface.components.approve as { value: string }
    const cancel = result.surface.components.cancel as { value: string }
    expect(approve.value.startsWith("wfapp:")).toBe(true)
    expect(cancel.value.startsWith("wfcan:")).toBe(true)

    const bindings = await getDb().connectorCallbackBindings.toArray()
    const approveBinding = bindings.find((b) => b.kind === "wf_approve")
    const cancelBinding = bindings.find((b) => b.kind === "wf_cancel")
    expect(approveBinding).toBeDefined()
    expect(cancelBinding).toBeDefined()
    expect(approveBinding?.payload).toMatchObject({
      workflowId: wf.id,
      workflowName: "Daily Standup",
      runParams: { focus: "today" },
      triggeredFrom: {
        source: "im",
        adapterId: "wecom:a",
        conversationKey: "wecom:wecom:a:room",
        sessionId: "s1",
      },
    })
    expect(result.instruction).toContain("Attach the returned `surface`")
    // No running inbound job in this harness → operators-only actor scope
    // (plan 2026-07-24 Phase 2).
    expect(approveBinding?.actorScope).toEqual({ mode: "operators" })
    expect(approveBinding?.allowedActions).toEqual(["approve", "cancel"])
    expect(cancelBinding?.actorScope).toEqual({ mode: "operators" })
  })

  it("scopes the approval to the current turn's sender when a job is running", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    await createWorkflow({ name: "Scoped Flow" })
    const { enqueueConnectorInboundJob, claimConnectorInboundJob } =
      await import("@/lib/db/connector-inbound-jobs")
    const job = await enqueueConnectorInboundJob(
      {
        platform: "wecom",
        adapterId: "wecom:a",
        selfId: "bot",
        messageId: "m_turn",
        conversationRef: { platform: "wecom", adapterId: "wecom:a" },
        conversationKey: "wecom:wecom:a:room",
        sender: {
          id: "wecom:u_requester",
          platform: "wecom",
          adapterId: "wecom:a",
          remoteUserId: "u_requester",
        },
        channel: { id: "wecom:wecom:a:room", kind: "group" },
        segments: [{ type: "text", text: "run it" }],
        plainText: "run it",
        mentions: { selfMentioned: false, users: [] },
        timestamp: Date.now(),
        raw: {},
      },
      "queue"
    )
    await claimConnectorInboundJob(job.id, { leaseOwner: "test", leaseMs: 60_000 })

    const result = (await runByNameTool.execute({ name: "Scoped Flow" }, ctx("s1"))) as {
      ok: boolean
    }
    expect(result.ok).toBe(true)
    const bindings = await getDb().connectorCallbackBindings.toArray()
    const approveBinding = bindings.find((b) => b.kind === "wf_approve")
    expect(approveBinding?.actorScope).toEqual({
      mode: "initiator",
      allowedUserIds: ["u_requester"],
    })
    expect(
      (approveBinding?.payload?.triggeredFrom as { initiator?: { remoteUserId?: string } })
        ?.initiator?.remoteUserId
    ).toBe("u_requester")
  })
})

describe("wf_subscribe_workflow_fanout", () => {
  it("rejects when the session has no IM binding", async () => {
    await seedSession({ sessionId: "s1", bindToIM: false })
    await createWorkflow({ name: "Anything" })
    const result = (await subscribeTool.execute({ name: "Anything" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("not-an-im-session")
  })

  it("rejects empty / unknown / ambiguous name with structured errors", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const empty = (await subscribeTool.execute({ name: "  " }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(empty.error?.code).toBe("invalid-name")

    const notFound = (await subscribeTool.execute({ name: "ghost-flow" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(notFound.error?.code).toBe("workflow-not-found")

    await createWorkflow({ name: "Report A" })
    await createWorkflow({ name: "Report B" })
    const ambiguous = (await subscribeTool.execute({ name: "report" }, ctx("s1"))) as {
      ok: boolean
      error?: { code: string }
    }
    expect(ambiguous.error?.code).toBe("workflow-ambiguous")
  })

  it("writes wf_fanout_approve + wf_fanout_cancel bindings + returns the surface", async () => {
    await seedSession({ sessionId: "s1", bindToIM: true })
    const wf = await createWorkflow({ name: "Deploy Pipeline" })
    const result = (await subscribeTool.execute({ name: "Deploy Pipeline" }, ctx("s1"))) as {
      ok: boolean
      workflowId: string
      surface: { components: Record<string, unknown> }
      surfaceId: string
      instruction: string
    }
    expect(result.ok).toBe(true)
    expect(result.workflowId).toBe(wf.id)
    expect(result.surfaceId.startsWith("wffanout:")).toBe(true)

    const bindings = await getDb().connectorCallbackBindings.toArray()
    const approve = bindings.find((b) => b.kind === "wf_fanout_approve")
    const cancel = bindings.find((b) => b.kind === "wf_fanout_cancel")
    expect(approve).toBeDefined()
    expect(cancel).toBeDefined()
    expect(approve?.payload).toMatchObject({
      workflowId: wf.id,
      workflowName: "Deploy Pipeline",
      target: {
        adapterId: "wecom:a",
        conversationKey: "wecom:wecom:a:room",
      },
      createdBy: "claude-tool",
    })
  })
})
