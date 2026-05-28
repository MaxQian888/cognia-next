import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"
import { startWorkflowFromIM } from "./start-from-im"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

async function waitForRun(runId: string, timeoutMs = 2000): Promise<unknown> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const row = await getDb().workflowRuns.get(runId)
    if (row) return row
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`run ${runId} did not appear within ${timeoutMs}ms`)
}

describe("startWorkflowFromIM", () => {
  it("rejects when the workflow id does not exist", async () => {
    const result = await startWorkflowFromIM({
      workflowId: "wf_missing",
      triggeredFrom: { source: "im", adapterId: "ad", conversationKey: "ck", sessionId: "s" },
    })
    expect(result).toEqual({ ok: false, reason: "workflow-not-found", workflowId: "wf_missing" })
  })

  it("persists a run row with triggeredBy populated", async () => {
    const wf = await createWorkflow({ name: "Sample" })
    const result = await startWorkflowFromIM({
      workflowId: wf.id,
      runParams: { topic: "test" },
      triggeredFrom: {
        source: "im",
        adapterId: "wecom:a",
        conversationKey: "wecom:a:room1",
        sessionId: "sess_1",
      },
    })
    if (!result.ok) throw new Error("expected ok start")
    const row = (await waitForRun(result.runId)) as {
      triggeredBy?: { source: string; adapterId?: string; conversationKey?: string }
      triggerKind?: string
      triggerPayload?: unknown
      triggerBinding?: { adapterId?: string; conversationKey?: string; sessionId?: string }
    }
    expect(row.triggerKind).toBe("trigger.manual")
    expect(row.triggerPayload).toEqual({ topic: "test" })
    expect(row.triggeredBy).toEqual({
      source: "im",
      adapterId: "wecom:a",
      conversationKey: "wecom:a:room1",
      sessionId: "sess_1",
    })
    // triggerBinding mirrors the IM origin so existing binding-aware nodes
    // still see the conversation context.
    expect(row.triggerBinding?.adapterId).toBe("wecom:a")
    expect(row.triggerBinding?.conversationKey).toBe("wecom:a:room1")
  })
})
