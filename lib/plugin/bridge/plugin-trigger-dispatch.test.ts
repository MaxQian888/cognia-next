import { dispatchPluginTrigger } from "./plugin-trigger-dispatch"
import type { TriggerRegistration } from "@/lib/workflow/triggers/registry"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))
jest.mock("../contracts/diagnostics-store", () => ({
  recordSilentFailure: jest.fn(),
}))
jest.mock("@/lib/workflow/triggers/registry", () => ({
  getPluginTrigger: jest.fn(),
  isTriggerMuted: jest.fn(() => false),
  listPluginTriggers: jest.fn(() => []),
}))
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("@/lib/db/workflows", () => ({
  getWorkflow: jest.fn(),
}))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const diag = require("../contracts/diagnostics-store") as { recordSilentFailure: jest.Mock }
// eslint-disable-next-line @typescript-eslint/no-require-imports
const registry = require("@/lib/workflow/triggers/registry") as {
  getPluginTrigger: jest.Mock
  isTriggerMuted: jest.Mock
  listPluginTriggers: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const orchestrator = require("@/lib/workflow/runtime/trigger-bridge") as {
  dispatchTrigger: jest.Mock
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const workflows = require("@/lib/db/workflows") as { getWorkflow: jest.Mock }

const FAKE_REG: TriggerRegistration = {
  kind: "trigger.foo.bar",
  typeVersion: 1,
  pluginId: "foo",
  def: {
    kind: "trigger.bar",
    typeVersion: 1,
    label: "Bar",
    description: "",
    start: jest.fn().mockResolvedValue({ stop: jest.fn() }),
  } as unknown as TriggerRegistration["def"],
  instances: new Map(),
}

beforeEach(() => {
  diag.recordSilentFailure.mockReset()
  registry.getPluginTrigger.mockReset()
  registry.listPluginTriggers.mockReset().mockReturnValue([])
  registry.getPluginTrigger.mockImplementation((kind: string, typeVersion: number) =>
    registry
      .listPluginTriggers()
      .find(
        (registration: TriggerRegistration) =>
          registration.kind === kind && registration.typeVersion === typeVersion
      )
  )
  registry.isTriggerMuted.mockReset().mockReturnValue(false)
  orchestrator.dispatchTrigger.mockReset().mockResolvedValue(undefined)
  workflows.getWorkflow.mockReset().mockResolvedValue({
    id: "wf-1",
    nodes: [
      {
        id: "trigger-node",
        type: "trigger.foo.bar",
        typeVersion: 1,
        data: { params: {} },
      },
    ],
  })
})

describe("dispatchPluginTrigger", () => {
  it("prefixes the kind, looks up the registration, and dispatches", async () => {
    registry.listPluginTriggers.mockReturnValue([FAKE_REG])
    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf-1",
      kind: "trigger.bar",
      payload: { hello: "world" },
    })
    expect(result).toEqual({ ok: true, prefixedKind: "trigger.foo.bar" })
    expect(orchestrator.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        kind: "trigger.foo.bar",
        triggerId: "trigger-node",
        payload: { hello: "world" },
        originAt: expect.any(Number),
      })
    )
    expect(diag.recordSilentFailure).not.toHaveBeenCalled()
  })

  it("records a silent failure when no live registration exists for the prefixed kind", async () => {
    registry.getPluginTrigger.mockReturnValue(undefined)
    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf",
      kind: "trigger.nonexistent",
      payload: null,
    })
    expect(result).toEqual({
      ok: false,
      prefixedKind: "trigger.foo.nonexistent",
      rejectedReason: "not-registered",
    })
    expect(diag.recordSilentFailure).toHaveBeenCalledWith(
      "foo",
      expect.objectContaining({ site: "trigger.dispatch" }),
      expect.any(Error)
    )
    expect(orchestrator.dispatchTrigger).not.toHaveBeenCalled()
  })

  it("returns muted reason without calling the orchestrator when isTriggerMuted is true", async () => {
    registry.getPluginTrigger.mockReturnValue(FAKE_REG)
    registry.isTriggerMuted.mockReturnValue(true)
    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf-muted",
      kind: "trigger.bar",
      payload: { a: 1 },
    })
    expect(result).toEqual({
      ok: false,
      prefixedKind: "trigger.foo.bar",
      rejectedReason: "muted",
    })
    expect(orchestrator.dispatchTrigger).not.toHaveBeenCalled()
    expect(diag.recordSilentFailure).not.toHaveBeenCalled()
  })

  it("routes orchestrator failures through recordSilentFailure", async () => {
    registry.listPluginTriggers.mockReturnValue([FAKE_REG])
    orchestrator.dispatchTrigger.mockRejectedValueOnce(new Error("orchestrator boom"))
    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf",
      kind: "trigger.bar",
      payload: 1,
    })
    expect(result.ok).toBe(false)
    expect(result.rejectedReason).toBe("dispatch-failed")
    expect(diag.recordSilentFailure).toHaveBeenCalledWith(
      "foo",
      expect.objectContaining({
        site: "trigger.dispatch",
        message: expect.stringContaining("dispatch failed"),
      }),
      expect.any(Error)
    )
  })

  it("routes an explicit triggerId when multiple same-kind roots exist", async () => {
    registry.listPluginTriggers.mockReturnValue([FAKE_REG])
    workflows.getWorkflow.mockResolvedValue({
      id: "wf-1",
      nodes: [
        { id: "root-a", type: "trigger.foo.bar", typeVersion: 1, data: { params: {} } },
        { id: "root-b", type: "trigger.foo.bar", typeVersion: 1, data: { params: {} } },
      ],
    })

    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf-1",
      kind: "trigger.bar",
      triggerId: "root-b",
      payload: { selected: "b" },
    })

    expect(result.ok).toBe(true)
    expect(orchestrator.dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: "root-b" })
    )
  })

  it("rejects an ambiguous legacy emission instead of starting every same-kind root", async () => {
    registry.listPluginTriggers.mockReturnValue([FAKE_REG])
    workflows.getWorkflow.mockResolvedValue({
      id: "wf-1",
      nodes: [
        { id: "root-a", type: "trigger.foo.bar", typeVersion: 1, data: { params: {} } },
        { id: "root-b", type: "trigger.foo.bar", typeVersion: 1, data: { params: {} } },
      ],
    })

    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf-1",
      kind: "trigger.bar",
      payload: null,
    })

    expect(result).toMatchObject({ ok: false, rejectedReason: "ambiguous-trigger" })
    expect(orchestrator.dispatchTrigger).not.toHaveBeenCalled()
    expect(diag.recordSilentFailure).toHaveBeenCalledWith(
      "foo",
      expect.objectContaining({ message: expect.stringContaining("multiple enabled nodes") }),
      expect.any(Error)
    )
  })

  it("rejects an explicit id that is disabled, missing, or owned by another kind", async () => {
    registry.listPluginTriggers.mockReturnValue([FAKE_REG])
    workflows.getWorkflow.mockResolvedValue({
      id: "wf-1",
      nodes: [
        {
          id: "root-a",
          type: "trigger.foo.bar",
          typeVersion: 1,
          data: { params: {}, disabled: true },
        },
      ],
    })

    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf-1",
      kind: "trigger.bar",
      triggerId: "root-a",
      payload: null,
    })

    expect(result).toMatchObject({ ok: false, rejectedReason: "trigger-node-not-found" })
    expect(orchestrator.dispatchTrigger).not.toHaveBeenCalled()
  })
})

// ── W4.4: version lookup scans real registrations (no 1..50 cap) ─────────────
describe("findAnyTriggerVersion via registry scan (W4.4)", () => {
  it("finds a trigger registered with typeVersion above 50 and picks the highest", async () => {
    registry.listPluginTriggers.mockReturnValue([
      { ...FAKE_REG, typeVersion: 99 },
      { ...FAKE_REG, typeVersion: 51 },
    ])
    workflows.getWorkflow.mockResolvedValue({
      id: "wf-1",
      nodes: [
        {
          id: "trigger-node",
          type: "trigger.foo.bar",
          typeVersion: 99,
          data: { params: {} },
        },
      ],
    })
    const result = await dispatchPluginTrigger({
      pluginId: "foo",
      workflowId: "wf-1",
      kind: "trigger.bar",
      payload: {},
    })
    expect(result.ok).toBe(true)
    expect(orchestrator.dispatchTrigger).toHaveBeenCalledTimes(1)
  })
})
