/**
 * @jest-environment jsdom
 */
import type { VisualWorkflow, WorkflowNode } from "@/types/workflow/visual"

// Mock the tauri-bridge module at hoist time so the bridge under test
// dispatches into our spies instead of the real `safeInvoke` path.
const mockRegister = jest.fn().mockResolvedValue(undefined)
const mockUnregister = jest.fn().mockResolvedValue(undefined)
const mockGetUrl = jest.fn().mockResolvedValue("http://127.0.0.1:9999/webhook/x")

jest.mock("./tauri-bridge", () => ({
  registerTrigger: (...args: unknown[]) => mockRegister(...args),
  unregisterTrigger: (...args: unknown[]) => mockUnregister(...args),
  getWebhookUrl: (...args: unknown[]) => mockGetUrl(...args),
}))

// IMPORTANT: import after the mock is declared.

import { syncWorkflowTriggers, unsyncWorkflowTriggers, getWebhookUrl } from "./webhook-bridge"

beforeEach(() => {
  mockRegister.mockClear()
  mockUnregister.mockClear()
  mockGetUrl.mockClear()
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
    await syncWorkflowTriggers(workflow([node("a", "ai.prompt")]))
    expect(mockRegister).not.toHaveBeenCalled()
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

  it("registers a trigger.github.webhook with GitHub signature mode and webhook shape", async () => {
    await syncWorkflowTriggers(
      workflow([
        node("trg", "trigger.github.webhook", {
          path: "github-events",
          method: "POST",
          hmacSecret: "ghs_secret",
          responseStatus: 202,
          responseTemplate: "accepted",
        }),
      ])
    )
    expect(mockRegister).toHaveBeenCalledTimes(1)
    expect(mockRegister.mock.calls[0][0]).toMatchObject({
      triggerId: "trg",
      kind: "trigger.github.webhook",
      webhookPath: "github-events",
      webhookMethod: "POST",
      webhookHmacSecret: "ghs_secret",
      webhookResponseStatus: 202,
      webhookResponseBody: "accepted",
      webhookAwaitResponse: false,
      signatureMode: "github",
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

  it("propagates the disabled flag to enabled=false", async () => {
    await syncWorkflowTriggers(
      workflow([node("trg", "trigger.cron", { cron: "* * * * *" }, /*disabled*/ true)])
    )
    expect(mockRegister.mock.calls[0][0]).toMatchObject({ enabled: false })
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
})

describe("unsyncWorkflowTriggers", () => {
  it("unregisters every trigger node by id", async () => {
    await unsyncWorkflowTriggers(
      workflow([
        node("trg_1", "trigger.cron", { cron: "* * * * *" }),
        node("a", "ai.prompt"),
        node("trg_2", "trigger.webhook", { path: "x" }),
      ])
    )
    expect(mockUnregister).toHaveBeenCalledTimes(2)
    expect(mockUnregister.mock.calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(["trg_1", "trg_2"])
    )
  })

  it("is a no-op when the workflow has no triggers", async () => {
    await unsyncWorkflowTriggers(workflow([node("a", "ai.prompt")]))
    expect(mockUnregister).not.toHaveBeenCalled()
  })
})

describe("getWebhookUrl re-export", () => {
  it("forwards to the tauri-bridge implementation", async () => {
    const url = await getWebhookUrl("trg")
    expect(mockGetUrl).toHaveBeenCalledWith("trg")
    expect(url).toBe("http://127.0.0.1:9999/webhook/x")
  })
})
