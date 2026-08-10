const emitWorkflowWaitEvent = jest.fn(async (event: Record<string, unknown>) => event)
jest.mock("@/lib/db/workflow-waitpoints", () => ({
  createWorkflowWaitEvent: (input: Record<string, unknown>) => ({ id: "event_1", ...input }),
  emitWorkflowWaitEvent: (event: Record<string, unknown>) => emitWorkflowWaitEvent(event),
}))
import { buildWakeTools } from "./wake-tools"

const tool = buildWakeTools().find((t) => t.name === "wf_emit_workflow_event")!
const exec = (args: Record<string, unknown>) => tool.execute(args, { config: {} } as never)

afterEach(() => {
  emitWorkflowWaitEvent.mockClear()
})

describe("wf_emit_workflow_event", () => {
  it("requires an eventKey", async () => {
    const r = (await exec({})) as { ok: boolean; error: { code: string } }
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("invalid-event-key")
  })

  it("persists the event payload before matching", async () => {
    emitWorkflowWaitEvent.mockImplementationOnce(async (event) => ({
      ...event,
      consumedByWaitpointId: "wp_1",
    }))
    const r = (await exec({ eventKey: "deploy-approved", data: { by: "alice" } })) as {
      ok: boolean
      delivered: boolean
    }
    expect(r.ok).toBe(true)
    expect(r.delivered).toBe(true)
    expect(emitWorkflowWaitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "deploy-approved",
        source: "wf_emit_workflow_event",
        data: { by: "alice" },
      })
    )
  })

  it("reports queued:true when nothing currently waits on the key", async () => {
    const r = (await exec({ eventKey: "nobody-home" })) as {
      ok: boolean
      delivered: boolean
      queued: boolean
    }
    expect(r.ok).toBe(true)
    expect(r.delivered).toBe(false)
    expect(r.queued).toBe(true)
  })
})
