import { MAX_PAYLOAD_BYTES } from "../protocol"

const mockDispatchPluginTrigger = jest.fn()

jest.mock("@/lib/plugin/bridge/plugin-trigger-dispatch", () => ({
  dispatchPluginTrigger: (...args: unknown[]) => mockDispatchPluginTrigger(...(args as [])),
}))

import { workflowEmitEvent } from "./workflow-emit-event"

const signal = () => new AbortController().signal
const payload = (over: Record<string, unknown> = {}) => ({
  workflowId: "wf-1",
  kind: "tick",
  payload: { n: 1 },
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockDispatchPluginTrigger.mockResolvedValue({ ok: true, prefixedKind: "p:tick" })
})

describe("success", () => {
  it("reports success only when the bridge result is ok", async () => {
    await expect(workflowEmitEvent("p", payload(), signal())).resolves.toEqual({
      ok: true,
      prefixedKind: "p:tick",
    })
  })

  it("forwards the plugin id, workflow, kind, payload, and triggerId", async () => {
    await workflowEmitEvent("acme.plugin", payload({ triggerId: "node-7" }), signal())
    expect(mockDispatchPluginTrigger).toHaveBeenCalledWith({
      pluginId: "acme.plugin",
      workflowId: "wf-1",
      kind: "tick",
      payload: { n: 1 },
      triggerId: "node-7",
    })
  })

  it("omits triggerId when it is not a string", async () => {
    await workflowEmitEvent("p", payload({ triggerId: 7 }), signal())
    expect(mockDispatchPluginTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: undefined })
    )
  })
})

describe("rejection", () => {
  // dispatchPluginTrigger never throws — every failure comes back as
  // { ok: false }. A naive `await` + `return` would report all five of these
  // as delivered.
  it.each([
    "not-registered",
    "dispatch-failed",
    "muted",
    "trigger-node-not-found",
    "ambiguous-trigger",
  ])("maps rejectedReason=%s to WORKFLOW_REJECTED", async (rejectedReason) => {
    mockDispatchPluginTrigger.mockResolvedValue({
      ok: false,
      prefixedKind: "p:tick",
      rejectedReason,
    })
    await expect(workflowEmitEvent("p", payload(), signal())).rejects.toMatchObject({
      code: "WORKFLOW_REJECTED",
    })
  })

  it("carries the reason in the message so a guest can distinguish them", async () => {
    mockDispatchPluginTrigger.mockResolvedValue({
      ok: false,
      prefixedKind: "p:tick",
      rejectedReason: "ambiguous-trigger",
    })
    await expect(workflowEmitEvent("p", payload(), signal())).rejects.toThrow(/ambiguous-trigger/)
  })

  it("still rejects when no reason was supplied", async () => {
    mockDispatchPluginTrigger.mockResolvedValue({ ok: false, prefixedKind: "p:tick" })
    await expect(workflowEmitEvent("p", payload(), signal())).rejects.toMatchObject({
      code: "WORKFLOW_REJECTED",
    })
  })
})

describe("validation", () => {
  it.each([
    ["missing workflowId", { workflowId: undefined }],
    ["blank workflowId", { workflowId: "   " }],
    ["non-string workflowId", { workflowId: 5 }],
    ["missing kind", { kind: undefined }],
    ["blank kind", { kind: "" }],
  ])("rejects %s as INVALID_REQUEST", async (_label, over) => {
    await expect(workflowEmitEvent("p", payload(over), signal())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
    expect(mockDispatchPluginTrigger).not.toHaveBeenCalled()
  })

  it("rejects an oversized payload before dispatching", async () => {
    const big = payload({ payload: { blob: "x".repeat(MAX_PAYLOAD_BYTES) } })
    await expect(workflowEmitEvent("p", big, signal())).rejects.toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
    })
    expect(mockDispatchPluginTrigger).not.toHaveBeenCalled()
  })

  it("rejects an unserializable payload", async () => {
    const cyclic: Record<string, unknown> = payload()
    cyclic.self = cyclic
    await expect(workflowEmitEvent("p", cyclic, signal())).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    })
  })
})

describe("cancellation", () => {
  it("reports CANCELLED when the request was aborted during dispatch", async () => {
    const controller = new AbortController()
    mockDispatchPluginTrigger.mockImplementation(async () => {
      controller.abort()
      return { ok: true, prefixedKind: "p:tick" }
    })
    await expect(workflowEmitEvent("p", payload(), controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    })
  })
})
