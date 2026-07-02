/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { dispatchTrigger, isTriggerEvent } from "./trigger-bridge"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type { TriggerEvent } from "@/types/workflow/visual"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  await getDb().workflowRuns.clear()
  await getDb().workflowRunEvents.clear()
})

describe("isTriggerEvent", () => {
  it("accepts a well-formed event", () => {
    expect(
      isTriggerEvent({
        workflowId: "wf",
        kind: "trigger.cron",
        payload: {},
        originAt: 1,
      })
    ).toBe(true)
  })

  it.each([
    ["null", null],
    ["string", "wf"],
    ["missing workflowId", { kind: "trigger.cron", originAt: 0 }],
    ["missing kind", { workflowId: "wf", originAt: 0 }],
    ["missing originAt", { workflowId: "wf", kind: "trigger.cron" }],
    ["non-numeric originAt", { workflowId: "wf", kind: "trigger.cron", originAt: "x" }],
  ])("rejects %s", (_label, value) => {
    expect(isTriggerEvent(value as unknown)).toBe(false)
  })
})

describe("dispatchTrigger", () => {
  it("runs the workflow when the id resolves", async () => {
    const wf = await createWorkflow({
      name: "x",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
        {
          id: "n_set",
          type: "flow.set",
          typeVersion: 1,
          position: { x: 200, y: 0 },
          data: { label: "set", params: { variable: "x", value: 1 } },
        },
      ],
      edges: [{ id: "e1", source: "n_start", target: "n_set" }],
    })
    const trigger: TriggerEvent = {
      workflowId: wf.id,
      kind: "trigger.cron",
      payload: { firedAt: 0 },
      originAt: Date.now(),
    }
    await dispatchTrigger(trigger)
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.length).toBe(1)
    expect(runs[0].workflowId).toBe(wf.id)
    expect(runs[0].triggerKind).toBe("trigger.cron")
    expect(runs[0].status).toBe("succeeded")
  })

  it("persists opts.triggeredBy onto the run row (ADR-0060)", async () => {
    const wf = await createWorkflow({
      name: "x",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      edges: [],
    })
    await dispatchTrigger(
      { workflowId: wf.id, kind: "trigger.manual", payload: {}, originAt: Date.now() },
      { triggeredBy: { source: "api", deviceId: "dev-42" } }
    )
    const runs = await getDb().workflowRuns.toArray()
    expect(runs.length).toBe(1)
    expect(runs[0].triggeredBy).toEqual({ source: "api", deviceId: "dev-42" })
    expect(runs[0].triggeredBySource).toBe("api")
  })

  it("fires the onWorkflowTriggerFired plugin hook before running", async () => {
    const wf = await createWorkflow({
      name: "x",
      nodes: [
        {
          id: "n_start",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 0, y: 0 },
          data: { label: "start", params: {} },
        },
      ],
      edges: [],
    })
    const spy = jest.spyOn(getPluginEventHooks(), "dispatchWorkflowTriggerFired")
    const payload = { firedAt: 7 }
    await dispatchTrigger({ workflowId: wf.id, kind: "trigger.cron", payload, originAt: 1 })
    expect(spy).toHaveBeenCalledWith(wf.id, "trigger.cron", payload)
    spy.mockRestore()
  })

  it("does not throw when the workflow is missing", async () => {
    const trigger: TriggerEvent = {
      workflowId: "wf_does_not_exist",
      kind: "trigger.cron",
      payload: {},
      originAt: Date.now(),
    }
    await expect(dispatchTrigger(trigger)).resolves.toBeUndefined()
    const runs = await getDb().workflowRuns.toArray()
    expect(runs).toEqual([])
  })
})
