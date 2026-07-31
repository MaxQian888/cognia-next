import { subscribeWake, _clearWakeBusForTest } from "@/lib/workflow/runtime/wake-bus"
import { buildWakeTools } from "./wake-tools"

const tool = buildWakeTools().find((t) => t.name === "wf_emit_workflow_event")!
const exec = (args: Record<string, unknown>) => tool.execute(args, { config: {} } as never)

afterEach(() => {
  _clearWakeBusForTest()
})

describe("wf_emit_workflow_event", () => {
  it("requires an eventKey", async () => {
    const r = (await exec({})) as { ok: boolean; error: { code: string } }
    expect(r.ok).toBe(false)
    expect(r.error.code).toBe("invalid-event-key")
  })

  it("wakes a waiting subscriber and delivers the payload", async () => {
    const wait = subscribeWake("deploy-approved")
    const r = (await exec({ eventKey: "deploy-approved", data: { by: "alice" } })) as {
      ok: boolean
      delivered: boolean
    }
    expect(r.ok).toBe(true)
    expect(r.delivered).toBe(true)
    await expect(wait).resolves.toMatchObject({
      source: "wf_emit_workflow_event",
      data: { by: "alice" },
    })
  })

  it("reports delivered:false when nothing waits on the key (dropped, not queued)", async () => {
    const r = (await exec({ eventKey: "nobody-home" })) as { ok: boolean; delivered: boolean }
    expect(r.ok).toBe(true)
    expect(r.delivered).toBe(false)
  })
})
