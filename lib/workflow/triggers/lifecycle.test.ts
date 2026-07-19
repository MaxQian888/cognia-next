/** @jest-environment jsdom */

import type { VisualWorkflow } from "@/types/workflow/visual"
import type { PluginTriggerDef, PluginTriggerStartContext } from "@/types/plugin/plugin-workflow"
import {
  __resetTriggerRegistryForTesting,
  registerPluginTrigger,
  unregisterPluginTrigger,
  type TriggerRegistration,
} from "./registry"

const dispatchPluginTrigger = jest.fn(async (_input: unknown) => ({ ok: true }))
const listWorkflows = jest.fn(async () => [] as VisualWorkflow[])
jest.mock("@/lib/plugin/bridge/plugin-trigger-dispatch", () => ({
  dispatchPluginTrigger: (input: unknown) => dispatchPluginTrigger(input),
}))
jest.mock("@/lib/db/workflows", () => ({
  listWorkflows: () => listWorkflows(),
}))
jest.mock("@/lib/plugin/contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))

import {
  _waitForPluginTriggerReconciliationForTest,
  disposePluginTriggerLifecycle,
  initPluginTriggerLifecycle,
  syncPluginTriggerInstances,
} from "./lifecycle"

function workflow(params: Record<string, unknown> = { channel: "alpha" }): VisualWorkflow {
  return {
    id: "wf-1",
    schemaVersion: 2,
    name: "Plugin trigger",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "root-1",
        type: "trigger.foo.watch" as VisualWorkflow["nodes"][number]["type"],
        typeVersion: 3,
        position: { x: 0, y: 0 },
        data: { label: "Watch", params },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 1000,
      concurrency: 1,
      retryDefaults: { attempts: 1, backoff: "fixed", baseMs: 0 },
    },
  }
}

function registration(
  start: jest.Mock = jest.fn(async (_ctx: unknown) => ({
    stop: jest.fn(async () => undefined),
  }))
): TriggerRegistration {
  return {
    kind: "trigger.foo.watch",
    typeVersion: 3,
    pluginId: "foo",
    def: {
      kind: "trigger.watch",
      typeVersion: 3,
      label: "Watch",
      description: "",
      iconName: "Radio",
      paramsSchema: { type: "object" },
      start,
    } as unknown as PluginTriggerDef,
    instances: new Map(),
  }
}

beforeEach(() => {
  __resetTriggerRegistryForTesting()
  dispatchPluginTrigger.mockClear()
  listWorkflows.mockReset().mockResolvedValue([])
  initPluginTriggerLifecycle()
})

afterEach(async () => {
  await disposePluginTriggerLifecycle()
  __resetTriggerRegistryForTesting()
})

it("starts one exact-root instance and routes its emitted payload with triggerId", async () => {
  const start = jest.fn(async (_ctx: unknown) => ({ stop: jest.fn(async () => undefined) }))
  const reg = registration(start)
  registerPluginTrigger(reg)

  await syncPluginTriggerInstances(workflow())

  expect(start).toHaveBeenCalledTimes(1)
  const ctx = start.mock.calls[0][0] as PluginTriggerStartContext
  expect(ctx).toMatchObject({
    workflowId: "wf-1",
    triggerId: "root-1",
    params: { channel: "alpha" },
  })
  ctx.emit({ event: 1 })
  expect(dispatchPluginTrigger).toHaveBeenCalledWith({
    pluginId: "foo",
    workflowId: "wf-1",
    kind: "trigger.watch",
    triggerId: "root-1",
    payload: { event: 1 },
  })
})

it("keeps unchanged instances, but stops and restarts when authored params change", async () => {
  const stop = jest.fn(async () => undefined)
  const start = jest.fn(async () => ({ stop }))
  const reg = registration(start)
  registerPluginTrigger(reg)

  await syncPluginTriggerInstances(workflow())
  await syncPluginTriggerInstances(workflow({ channel: "alpha" }))
  expect(start).toHaveBeenCalledTimes(1)

  await syncPluginTriggerInstances(workflow({ channel: "beta" }))
  expect(stop).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledTimes(2)
  expect([...reg.instances.values()][0].paramsSignature).toContain("beta")
})

it("continues reconciliation when a plugin source throws during stop", async () => {
  const failingStop = jest.fn(async () => {
    throw new Error("stop failed")
  })
  const start = jest
    .fn()
    .mockResolvedValueOnce({ stop: failingStop })
    .mockResolvedValueOnce({ stop: jest.fn(async () => undefined) })
  const reg = registration(start)
  registerPluginTrigger(reg)
  await syncPluginTriggerInstances(workflow())

  await expect(syncPluginTriggerInstances(workflow({ channel: "beta" }))).resolves.toBeUndefined()

  expect(failingStop).toHaveBeenCalledTimes(1)
  expect(start).toHaveBeenCalledTimes(2)
  expect([...reg.instances.values()][0].paramsSignature).toContain("beta")
})

it("stops a live instance when its node is disabled or the workflow becomes a template", async () => {
  const stop = jest.fn(async () => undefined)
  const reg = registration(jest.fn(async () => ({ stop })))
  registerPluginTrigger(reg)
  await syncPluginTriggerInstances(workflow())

  const disabled = workflow()
  disabled.nodes[0].data.disabled = true
  await syncPluginTriggerInstances(disabled)

  expect(stop).toHaveBeenCalledTimes(1)
  expect(reg.instances.size).toBe(0)
})

it("aborts and tears down an in-flight start when the node is disabled", async () => {
  let resolveStart!: (handle: { stop: jest.Mock }) => void
  const start = jest.fn(
    (_ctx: unknown) =>
      new Promise<{ stop: jest.Mock }>((resolve) => {
        resolveStart = resolve
      })
  )
  const reg = registration(start)
  registerPluginTrigger(reg)
  const initialSync = syncPluginTriggerInstances(workflow())
  for (let attempt = 0; attempt < 5 && start.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve()
  }
  expect(start).toHaveBeenCalledTimes(1)
  const ctx = start.mock.calls[0][0] as PluginTriggerStartContext

  const disabled = workflow()
  disabled.nodes[0].data.disabled = true
  await syncPluginTriggerInstances(disabled)

  expect(ctx.signal.aborted).toBe(true)
  const stop = jest.fn(async () => undefined)
  resolveStart({ stop })
  await initialSync

  expect(stop).toHaveBeenCalledTimes(1)
  expect(reg.instances.size).toBe(0)
})

it("disposes without waiting for a non-cooperative start and stops it if it later resolves", async () => {
  let resolveStart!: (handle: { stop: jest.Mock }) => void
  const start = jest.fn(
    (_ctx: unknown) =>
      new Promise<{ stop: jest.Mock }>((resolve) => {
        resolveStart = resolve
      })
  )
  registerPluginTrigger(registration(start))
  const initialSync = syncPluginTriggerInstances(workflow())
  for (let attempt = 0; attempt < 5 && start.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve()
  }
  const ctx = start.mock.calls[0][0] as PluginTriggerStartContext

  await expect(disposePluginTriggerLifecycle()).resolves.toBeUndefined()
  expect(ctx.signal.aborted).toBe(true)

  const stop = jest.fn(async () => undefined)
  resolveStart({ stop })
  await initialSync
  expect(stop).toHaveBeenCalledTimes(1)
})

it("aborts a cooperative in-flight start as soon as its registration is removed", async () => {
  const start = jest.fn(
    (ctx: PluginTriggerStartContext) =>
      new Promise<never>((_resolve, reject) => {
        ctx.signal.addEventListener(
          "abort",
          () => reject(new DOMException("Plugin trigger unregistered", "AbortError")),
          { once: true }
        )
      })
  )
  registerPluginTrigger(registration(start))
  const initialSync = syncPluginTriggerInstances(workflow())
  for (let attempt = 0; attempt < 5 && start.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve()
  }
  const ctx = start.mock.calls[0][0]

  await unregisterPluginTrigger("trigger.foo.watch", 3)
  await initialSync

  expect(ctx.signal.aborted).toBe(true)
})

it("does not reconcile a late registration after lifecycle disposal", async () => {
  let resolveWorkflows!: (rows: VisualWorkflow[]) => void
  listWorkflows.mockReturnValue(
    new Promise<VisualWorkflow[]>((resolve) => {
      resolveWorkflows = resolve
    })
  )
  const start = jest.fn(async () => ({ stop: jest.fn(async () => undefined) }))
  registerPluginTrigger(registration(start))
  for (let attempt = 0; attempt < 5 && listWorkflows.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve()
  }

  await disposePluginTriggerLifecycle()
  resolveWorkflows([workflow()])
  await Promise.resolve()
  await Promise.resolve()

  expect(start).not.toHaveBeenCalled()
})

it("reconciles existing workflows when a trigger registers after runtime startup", async () => {
  const wf = workflow()
  listWorkflows.mockResolvedValue([wf])
  const reg = registration()

  registerPluginTrigger(reg)
  await Promise.resolve()
  await _waitForPluginTriggerReconciliationForTest()

  expect(listWorkflows).toHaveBeenCalledTimes(1)
  expect(reg.instances.has("wf-1::root-1")).toBe(true)
})
