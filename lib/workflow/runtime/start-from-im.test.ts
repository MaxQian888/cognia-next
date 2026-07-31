/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"
import { startWorkflowFromIM } from "./start-from-im"

async function waitForTerminalRun(runId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const row = await getDb().workflowRuns.get(runId)
    if (row && ["succeeded", "failed", "cancelled"].includes(row.status)) return
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Workflow run ${runId} did not reach a terminal state`)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

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
    const row = (await getDb().workflowRuns.get(result.runId)) as {
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

    // `startWorkflowFromIM` intentionally returns after the durable run row
    // lands. Let its detached execution finish before Jest tears down the
    // module environment so late dynamic imports cannot leak across tests.
    await waitForTerminalRun(result.runId)
  })
})
