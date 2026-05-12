import {
  createWorkflowSource,
  toUnifiedTrigger,
  WorkflowSourceWriteNotSupportedError,
} from "./workflow-source"
import type { VisualWorkflow, WorkflowTriggerRow } from "@/types/workflow/visual"

function makeRow(overrides: Partial<WorkflowTriggerRow> = {}): WorkflowTriggerRow {
  return {
    id: "trigger-1",
    workflowId: "wf-1",
    kind: "trigger.cron",
    enabled: true,
    cron: "0 9 * * *",
    nextFireAt: 1_700_000_000_000,
    createdAt: 1_600_000_000_000,
    updatedAt: 1_600_000_000_000,
    ...overrides,
  }
}

function makeWorkflow(overrides: Partial<VisualWorkflow> = {}): VisualWorkflow {
  return {
    id: "wf-1",
    schemaVersion: 1,
    name: "Daily digest",
    createdAt: 1_600_000_000_000,
    updatedAt: 1_600_000_000_000,
    nodes: [
      {
        id: "trigger-1",
        type: "trigger.cron",
        position: { x: 0, y: 0 },
        data: { params: { cron: "0 9 * * *" } },
      },
    ],
    edges: [],
    settings: { timezone: "UTC" },
    ...overrides,
  } as VisualWorkflow
}

describe("toUnifiedTrigger", () => {
  it("maps a cron trigger row", () => {
    const u = toUnifiedTrigger(makeRow())
    expect(u.unifiedId).toBe("workflow:trigger-1")
    expect(u.kind).toBe("workflow")
    expect(u.sourceId).toBe("trigger-1")
    expect(u.status).toBe("active")
    expect(u.triggerSummary).toEqual({
      type: "cron",
      cron: "0 9 * * *",
      eventType: "trigger.cron",
    })
    expect(u.nextRunAt).toBe(1_700_000_000_000)
    expect(u.capabilities).toEqual({
      runNow: true,
      pause: true,
      edit: false,
      delete: false,
    })
    expect(u.origin.deepLinkHref).toBe("/workflows/wf-1")
  })

  it("maps disabled rows to paused", () => {
    expect(toUnifiedTrigger(makeRow({ enabled: false })).status).toBe("paused")
  })

  it("maps webhook triggers to event type with webhook description", () => {
    const u = toUnifiedTrigger(
      makeRow({
        kind: "trigger.webhook",
        cron: undefined,
        webhookPath: "/hook/foo",
      })
    )
    expect(u.triggerSummary.type).toBe("event")
    expect(u.name).toContain("webhook /hook/foo")
  })
})

describe("createWorkflowSource", () => {
  function makeStubs(initial: WorkflowTriggerRow[] = [makeRow()]) {
    let triggers: WorkflowTriggerRow[] = [...initial]
    let workflow = makeWorkflow()
    const db = {
      workflowTriggers: {
        toArray: jest.fn(async () => triggers),
        get: jest.fn(async (id: string) => triggers.find((t) => t.id === id)),
        update: jest.fn(async (id: string, changes: Partial<WorkflowTriggerRow>) => {
          triggers = triggers.map((t) => (t.id === id ? { ...t, ...changes } : t))
          return 1
        }),
      },
      workflows: {
        get: jest.fn(async (id: string) => (id === workflow.id ? workflow : undefined)),
        put: jest.fn(async (wf: VisualWorkflow) => {
          workflow = wf
          return wf.id
        }),
      },
    }
    const sync = jest.fn(async () => {})
    const run = jest.fn(async () => ({ status: "succeeded" }))
    return { db, sync, run, getTriggers: () => triggers, getWorkflow: () => workflow }
  }

  it("list() returns mapped triggers", async () => {
    const { db, sync, run } = makeStubs()
    const source = createWorkflowSource({ db, sync, run })
    const items = await source.list()
    expect(items).toHaveLength(1)
    expect(items[0].unifiedId).toBe("workflow:trigger-1")
  })

  it("get() returns undefined for missing trigger", async () => {
    const { db, sync, run } = makeStubs()
    const source = createWorkflowSource({ db, sync, run })
    expect(await source.get("missing")).toBeUndefined()
  })

  it("create() rejects with the documented sentinel error", async () => {
    const { db, sync, run } = makeStubs()
    const source = createWorkflowSource({ db, sync, run })
    await expect((source.create as () => Promise<unknown>)()).rejects.toBeInstanceOf(
      WorkflowSourceWriteNotSupportedError
    )
  })

  it("delete() rejects with the documented sentinel error", async () => {
    const { db, sync, run } = makeStubs()
    const source = createWorkflowSource({ db, sync, run })
    await expect(source.delete("trigger-1")).rejects.toBeInstanceOf(
      WorkflowSourceWriteNotSupportedError
    )
  })

  it("pause flips enabled on the row, on the workflow node, and re-syncs Rust", async () => {
    const stubs = makeStubs()
    const source = createWorkflowSource({ db: stubs.db, sync: stubs.sync, run: stubs.run })
    await source.pause("trigger-1")
    expect(stubs.db.workflowTriggers.update).toHaveBeenCalledWith(
      "trigger-1",
      expect.objectContaining({ enabled: false })
    )
    expect(stubs.getWorkflow().nodes[0].data.disabled).toBe(true)
    expect(stubs.sync).toHaveBeenCalledTimes(1)
  })

  it("resume flips enabled back to true", async () => {
    const stubs = makeStubs([makeRow({ enabled: false })])
    const source = createWorkflowSource({ db: stubs.db, sync: stubs.sync, run: stubs.run })
    await source.resume("trigger-1")
    expect(stubs.db.workflowTriggers.update).toHaveBeenCalledWith(
      "trigger-1",
      expect.objectContaining({ enabled: true })
    )
    expect(stubs.getWorkflow().nodes[0].data.disabled).toBe(false)
  })

  it("update() patches both the row and the workflow node when cron changes", async () => {
    const stubs = makeStubs()
    const source = createWorkflowSource({ db: stubs.db, sync: stubs.sync, run: stubs.run })
    await source.update("trigger-1", { cron: "*/5 * * * *" })
    expect(stubs.db.workflowTriggers.update).toHaveBeenCalledWith(
      "trigger-1",
      expect.objectContaining({ cron: "*/5 * * * *" })
    )
    expect(stubs.getWorkflow().nodes[0].data.params).toEqual({ cron: "*/5 * * * *" })
  })

  it("update() is a no-op when no recognized fields are provided", async () => {
    const stubs = makeStubs()
    const source = createWorkflowSource({ db: stubs.db, sync: stubs.sync, run: stubs.run })
    await source.update("trigger-1", {})
    expect(stubs.db.workflowTriggers.update).not.toHaveBeenCalled()
    expect(stubs.sync).not.toHaveBeenCalled()
  })

  it("runNow invokes runWorkflow with a manual trigger event", async () => {
    const stubs = makeStubs()
    const source = createWorkflowSource({ db: stubs.db, sync: stubs.sync, run: stubs.run })
    await source.runNow("trigger-1")
    expect(stubs.run).toHaveBeenCalledTimes(1)
    expect(stubs.run).toHaveBeenCalledWith(
      expect.objectContaining({
        workflow: expect.objectContaining({ id: "wf-1" }),
        triggerId: "trigger-1",
      })
    )
  })

  it("runNow is a no-op when the trigger or workflow row is missing", async () => {
    const stubs = makeStubs([])
    const source = createWorkflowSource({ db: stubs.db, sync: stubs.sync, run: stubs.run })
    await source.runNow("missing")
    expect(stubs.run).not.toHaveBeenCalled()
  })
})
