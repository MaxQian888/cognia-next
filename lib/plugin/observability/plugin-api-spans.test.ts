import {
  recordPluginApiAudit,
  type PluginApiAuditEvent,
} from "@/lib/plugin/contracts/interface-catalog"

import {
  PLUGIN_API_SPAN_PROVIDER,
  pluginApiAuditSpan,
  shouldTracePluginApiCall,
  startPluginApiSpanBridge,
  stopPluginApiSpanBridge,
} from "./plugin-api-spans"

const emitFinishedSpan = jest.fn()
jest.mock("@cognia/agent-trace/emitter", () => ({
  emitFinishedSpan: (...args: unknown[]) => emitFinishedSpan(...args),
}))

function audit(overrides: Partial<PluginApiAuditEvent> = {}): PluginApiAuditEvent {
  return {
    pluginId: "demo",
    methodId: "storage.get",
    runtime: "python",
    outcome: "allowed",
    durationMs: 12,
    dataClassification: "internal",
    ...overrides,
  }
}

afterEach(() => {
  stopPluginApiSpanBridge()
  emitFinishedSpan.mockClear()
})

describe("shouldTracePluginApiCall", () => {
  it("traces every call from a runtime that crosses a process boundary", () => {
    for (const runtime of ["python", "wasm", "vscode"] as const) {
      expect(shouldTracePluginApiCall(audit({ runtime }))).toBe(true)
    }
  })

  it("skips allowed in-renderer calls, which are ordinary function calls", () => {
    // Tracing these would bury the boundary-crossing calls under traffic the
    // caller can already see on its own stack.
    expect(shouldTracePluginApiCall(audit({ runtime: "frontend" }))).toBe(false)
    expect(shouldTracePluginApiCall(audit({ runtime: "hybrid" }))).toBe(false)
  })

  it("always traces a denial or an error, whatever the runtime", () => {
    expect(shouldTracePluginApiCall(audit({ runtime: "frontend", outcome: "denied" }))).toBe(true)
    expect(shouldTracePluginApiCall(audit({ runtime: "hybrid", outcome: "error" }))).toBe(true)
  })
})

describe("pluginApiAuditSpan", () => {
  it("dates the span backwards from completion so the waterfall lines up", () => {
    const span = pluginApiAuditSpan(audit({ durationMs: 40 }), 1_000)
    expect(span.startTime).toBe(960)
    expect(span.durationMs).toBe(40)
  })

  it("carries the plugin, the method and the runtime", () => {
    const span = pluginApiAuditSpan(audit({ methodId: "agent.run" }), 1_000)
    expect(span.pluginId).toBe("demo")
    expect(span.toolName).toBe("agent.run")
    expect(span.providerName).toBe(PLUGIN_API_SPAN_PROVIDER)
    expect(span.surface).toBe("plugin")
    expect(span.status).toBe("ok")
    expect(span.events?.[0]?.attributes).toMatchObject({
      runtime: "python",
      outcome: "allowed",
      dataClassification: "internal",
    })
  })

  it("distinguishes a denial from a thrown error", () => {
    const denied = pluginApiAuditSpan(audit({ outcome: "denied", errorCode: "PERMISSION" }), 1_000)
    expect(denied.status).toBe("error")
    expect(denied.errorType).toBe("plugin_api_denied")
    expect(denied.errorMessage).toBe("PERMISSION")

    const failed = pluginApiAuditSpan(audit({ outcome: "error", errorCode: "TypeError" }), 1_000)
    expect(failed.errorType).toBe("plugin_api_error")
  })

  it("never produces a negative duration", () => {
    expect(pluginApiAuditSpan(audit({ durationMs: -5 }), 1_000).durationMs).toBe(0)
  })
})

describe("startPluginApiSpanBridge", () => {
  it("emits a span for a python call and nothing for an allowed frontend one", () => {
    startPluginApiSpanBridge(() => 1_000)

    recordPluginApiAudit(audit())
    expect(emitFinishedSpan).toHaveBeenCalledTimes(1)
    expect(emitFinishedSpan.mock.calls[0][0]).toMatchObject({ toolName: "storage.get" })

    recordPluginApiAudit(audit({ runtime: "frontend" }))
    expect(emitFinishedSpan).toHaveBeenCalledTimes(1)
  })

  it("is idempotent so a re-initialized manager cannot double every span", () => {
    startPluginApiSpanBridge(() => 1_000)
    startPluginApiSpanBridge(() => 1_000)
    recordPluginApiAudit(audit())
    expect(emitFinishedSpan).toHaveBeenCalledTimes(1)
  })

  it("stops emitting once stopped", () => {
    startPluginApiSpanBridge(() => 1_000)
    stopPluginApiSpanBridge()
    recordPluginApiAudit(audit())
    expect(emitFinishedSpan).not.toHaveBeenCalled()
  })

  it("survives an emitter that throws — telemetry never breaks the call", () => {
    emitFinishedSpan.mockImplementationOnce(() => {
      throw new Error("dexie is closed")
    })
    startPluginApiSpanBridge(() => 1_000)
    expect(() => recordPluginApiAudit(audit())).not.toThrow()
  })
})
