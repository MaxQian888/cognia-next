/**
 * @jest-environment jsdom
 */
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

// Mock the tauri-bridge module at hoist time so the bridge under test
// dispatches into our spies instead of the real `safeInvoke` path.
const mockRegister = jest.fn().mockResolvedValue(undefined)
const mockUnregister = jest.fn().mockResolvedValue(undefined)
const mockGetUrl = jest.fn().mockResolvedValue("http://127.0.0.1:9999/webhook/x")
const mockPluginSync = jest.fn().mockResolvedValue(undefined)
const mockPluginUnsync = jest.fn().mockResolvedValue(undefined)

jest.mock("./tauri-bridge", () => ({
  registerTrigger: (...args: unknown[]) => mockRegister(...args),
  unregisterTrigger: (...args: unknown[]) => mockUnregister(...args),
  getWebhookUrl: (...args: unknown[]) => mockGetUrl(...args),
}))
jest.mock("@/lib/workflow/triggers/lifecycle", () => ({
  syncPluginTriggerInstances: (...args: unknown[]) => mockPluginSync(...args),
  unsyncPluginTriggerInstances: (...args: unknown[]) => mockPluginUnsync(...args),
}))

// IMPORTANT: import after the mock is declared.

import {
  _resetSyncedTriggerStateForTest,
  syncWorkflowTriggers,
  unsyncWorkflowTriggers,
  getWebhookUrl,
} from "./webhook-bridge"

beforeEach(() => {
  _resetSyncedTriggerStateForTest()
  mockRegister.mockClear()
  mockUnregister.mockClear()
  mockGetUrl.mockClear()
  mockPluginSync.mockClear()
  mockPluginUnsync.mockClear()
})

function node(
  id: string,
  type: WorkflowNode["type"],
  params: Record<string, unknown> = {},
  disabled = false
): WorkflowNode {
  return {
    id,
    type,
    typeVersion: 1,
    position: { x: 0, y: 0 },
    data: { label: id, params, disabled },
  }
}

function workflow(nodes: WorkflowNode[]): VisualWorkflow {
  return {
    id: "wf_a",
    schemaVersion: 1,
    name: "wf",
    createdAt: 0,
    updatedAt: 0,
    nodes,
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 0,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

describe("syncWorkflowTriggers", () => {
  it("registers nothing when the workflow has no trigger nodes", async () => {
    const wf = workflow([node("a", "ai.prompt")])
    await syncWorkflowTriggers(wf)
    expect(mockRegister).not.toHaveBeenCalled()
    expect(mockPluginSync).toHaveBeenCalledWith(wf)
  })

  it("registers a trigger.cron with the cron expression", async () => {
    await syncWorkflowTriggers(
      workflow([node("trg", "trigger.cron", { cron: "*/5 * * * *", timezone: "UTC" })])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0]).toMatchObject({
      workflowId: "wf_a",
      triggerId: "trg",
      kind: "trigger.cron",
      enabled: true,
      cron: "*/5 * * * *",
      timezone: "UTC",
    })
  })

  it("registers a trigger.webhook with method / hmacSecret / response shape", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("trg", "trigger.webhook", {
          path: "incoming",
          method: "POST",
          hmacSecret: "shh",
          responseStatus: 202,
          responseTemplate: "ok",
        }),
      ])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0]).toMatchObject({
      triggerId: "trg",
      kind: "trigger.webhook",
      webhookPath: "incoming",
      webhookMethod: "POST",
      webhookHmacSecret: "shh",
      webhookResponseStatus: 202,
      webhookResponseBody: "ok",
      // No io.webhook.respond node → the receiver replies synchronously.
      webhookAwaitResponse: false,
    })
  })

  it("sets webhookAwaitResponse when the workflow has an io.webhook.respond node", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("trg", "trigger.webhook", { path: "incoming", responseTimeoutMs: 8000 }),
        node("resp", "io.webhook.respond", { status: 200 }),
      ])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0]).toMatchObject({
      kind: "trigger.webhook",
      webhookAwaitResponse: true,
      webhookResponseTimeoutMs: 8000,
    })
  })

  it("does not register disabled triggers", async () => {
    await syncWorkflowTriggers(
      workflow([node("trg", "trigger.cron", { cron: "* * * * *" }, /*disabled*/ true)])
    )
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("does not register template or built-in gallery workflows", async () => {
    const template = { ...workflow([node("a", "trigger.manual")]), isTemplate: true }
    const builtIn = { ...workflow([node("b", "trigger.manual")]), isBuiltIn: true }

    await syncWorkflowTriggers(template)
    await syncWorkflowTriggers(builtIn)

    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("unregisters a trigger removed since the previous sync", async () => {
    await syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "* * * * *" })]))
    mockRegister.mockClear()

    await syncWorkflowTriggers(workflow([]))

    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "trg")
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("unregisters before re-registering a trigger whose kind changed", async () => {
    await syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "* * * * *" })]))
    mockRegister.mockClear()
    mockUnregister.mockClear()

    await syncWorkflowTriggers(workflow([node("trg", "trigger.webhook", { path: "incoming" })]))

    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "trg")
    expect(mockUnregister.mock.invocationCallOrder[0]).toBeLessThan(
      mockRegister.mock.invocationCallOrder[0]
    )
  })

  it("removes the previous live projection when an edited cron becomes invalid", async () => {
    await syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "* * * * *" })]))
    mockRegister.mockClear()
    mockUnregister.mockClear()

    await expect(
      syncWorkflowTriggers(workflow([node("trg", "trigger.cron", { cron: "invalid" })]))
    ).rejects.toThrow(/Cannot register workflow cron/)

    expect(mockUnregister).toHaveBeenCalledWith("wf_a", "trg")
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("registers TS-hook triggers with the base envelope only", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("a", "trigger.manual"),
        node("b", "trigger.chat.message"),
        node("c", "trigger.connector.inbound"),
        node("d", "trigger.goal.completed"),
        node("e", "trigger.terminal.command"),
        node("f", "trigger.desktop.event"),
        node("g", "trigger.team"),
      ])
    )
    expect(mockRegister).toHaveBeenCalledTimes(7)
    expect(mockRegister.mock.calls.map((call) => call[0].kind)).toEqual([
      "trigger.manual",
      "trigger.chat.message",
      "trigger.connector.inbound",
      "trigger.goal.completed",
      "trigger.terminal.command",
      "trigger.desktop.event",
      "trigger.team",
    ])
    for (const call of mockRegister.mock.calls) {
      expect(call[0]).not.toHaveProperty("cron")
      expect(call[0]).not.toHaveProperty("webhookPath")
    }
  })

  it("skips unknown trigger.* kinds without throwing (forward-compat)", async () => {
    await syncWorkflowTriggers(
      workflow([
        // A new trigger kind a future plugin might register; the bridge
        // shouldn't crash the canvas save path.
        node("trg", "trigger.future" as WorkflowNode["type"]),
      ])
    )
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it("dispatches all triggers in parallel", async () => {
    const order: string[] = []
    mockRegister.mockImplementationOnce(async (input: { triggerId: string }) => {
      order.push(`${input.triggerId}-end`)
    })
    mockRegister.mockImplementationOnce(async (input: { triggerId: string }) => {
      order.push(`${input.triggerId}-end`)
    })
    await syncWorkflowTriggers(
      workflow([
        node("a", "trigger.cron", { cron: "* * * * *" }),
        node("b", "trigger.cron", { cron: "* * * * *" }),
      ])
    )
    expect(order).toEqual(["a-end", "b-end"])
  })

  it("does not start plugin sources when startup sync is aborted during native registration", async () => {
    let resolveRegister!: () => void
    mockRegister.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRegister = resolve
        })
    )
    const controller = new AbortController()
    const pending = syncWorkflowTriggers(workflow([node("a", "trigger.manual")]), {
      signal: controller.signal,
    })
    await Promise.resolve()

    controller.abort()
    resolveRegister()
    await pending

    expect(mockPluginSync).not.toHaveBeenCalled()
  })
})

describe("unsyncWorkflowTriggers", () => {
  it("unregisters every trigger node by id", async () => {
    const wf = workflow([
      node("trg_1", "trigger.cron", { cron: "* * * * *" }),
      node("a", "ai.prompt"),
      node("trg_2", "trigger.webhook", { path: "x" }),
    ])
    await unsyncWorkflowTriggers(wf)
    expect(mockUnregister).toHaveBeenCalledTimes(2)
    expect(mockUnregister.mock.calls.map((c) => c[1])).toEqual(
      expect.arrayContaining(["trg_1", "trg_2"])
    )
    expect(mockPluginUnsync).toHaveBeenCalledWith(wf)
  })

  it("is a no-op when the workflow has no triggers", async () => {
    await unsyncWorkflowTriggers(workflow([node("a", "ai.prompt")]))
    expect(mockUnregister).not.toHaveBeenCalled()
  })
})

describe("getWebhookUrl re-export", () => {
  it("forwards to the tauri-bridge implementation", async () => {
    const url = await getWebhookUrl("wf_a", "trg")
    expect(mockGetUrl).toHaveBeenCalledWith("wf_a", "trg")
    expect(url).toBe("http://127.0.0.1:9999/webhook/x")
  })
})
