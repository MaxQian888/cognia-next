import {
  MAX_PAYLOAD_BYTES,
  parseRendererRequest,
  serializedByteLength,
  WASM_BRIDGE_ERROR_CODES,
  WASM_BRIDGE_OPERATIONS,
  WASM_RENDERER_CANCEL_EVENT,
  WASM_RENDERER_REQUEST_EVENT,
  WASM_RENDERER_RESPONSE_COMMAND,
} from "./protocol"

const valid = () => ({
  requestId: "req-1",
  pluginId: "acme.formatter",
  operation: "ai.generate-text",
  timeoutMs: 30_000,
  payload: { messages: [] },
})

describe("wire constants", () => {
  // These three strings are the entire integration surface with
  // crates/cognia-plugin-runtime/src/wasm/bridge.rs. A typo produces a silent
  // hang no other test can catch, because every renderer test fakes the bridge.
  it("match the Rust host's channel and command names exactly", () => {
    expect(WASM_RENDERER_REQUEST_EVENT).toBe("plugin-wasm://renderer-request")
    expect(WASM_RENDERER_CANCEL_EVENT).toBe("plugin-wasm://renderer-cancel")
    expect(WASM_RENDERER_RESPONSE_COMMAND).toBe("plugin_wasm_renderer_response")
  })

  it("declares the closed error-code vocabulary", () => {
    expect([...WASM_BRIDGE_ERROR_CODES]).toEqual([
      "CAPABILITY_DENIED",
      "INVALID_REQUEST",
      "PAYLOAD_TOO_LARGE",
      "TIMEOUT",
      "CANCELLED",
      "HOST_UNAVAILABLE",
      "PROVIDER_ERROR",
      "WORKFLOW_REJECTED",
    ])
  })

  it("declares only the two renderer-backed operations", () => {
    expect([...WASM_BRIDGE_OPERATIONS]).toEqual(["ai.generate-text", "workflow.emit-event"])
  })
})

describe("parseRendererRequest", () => {
  it("accepts a well-formed envelope", () => {
    const parsed = parseRendererRequest(valid())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw new Error("expected ok")
    expect(parsed.request.pluginId).toBe("acme.formatter")
    expect(parsed.request.operation).toBe("ai.generate-text")
  })

  it.each([
    ["null envelope", null],
    ["array envelope", []],
    ["string envelope", "nope"],
  ])("rejects a %s", (_label, raw) => {
    const parsed = parseRendererRequest(raw)
    expect(parsed.ok).toBe(false)
  })

  it("rejects a missing requestId and cannot echo an id back", () => {
    const parsed = parseRendererRequest({ ...valid(), requestId: "" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected failure")
    expect(parsed.requestId).toBeUndefined()
  })

  it("echoes requestId and pluginId back on later failures so the guest fails fast", () => {
    // Without this the guest waits out the full host timeout for a frame we
    // already know is unanswerable.
    const parsed = parseRendererRequest({ ...valid(), operation: "ai.nope" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected failure")
    expect(parsed.requestId).toBe("req-1")
    expect(parsed.pluginId).toBe("acme.formatter")
    expect(parsed.reason).toContain("unknown operation")
  })

  it("rejects a missing pluginId", () => {
    const parsed = parseRendererRequest({ ...valid(), pluginId: "" })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected failure")
    expect(parsed.reason).toContain("pluginId")
  })

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a string", "30000"],
  ])("rejects timeoutMs of %s", (_label, timeoutMs) => {
    const parsed = parseRendererRequest({ ...valid(), timeoutMs })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected failure")
    expect(parsed.reason).toContain("timeoutMs")
  })

  it.each([
    ["an array", []],
    ["null", null],
    ["a string", "x"],
  ])("rejects a payload that is %s", (_label, payload) => {
    const parsed = parseRendererRequest({ ...valid(), payload })
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("expected failure")
    expect(parsed.reason).toContain("payload")
  })

  it("accepts the workflow operation", () => {
    const parsed = parseRendererRequest({
      ...valid(),
      operation: "workflow.emit-event",
      payload: { workflowId: "wf", kind: "tick" },
    })
    expect(parsed.ok).toBe(true)
  })
})

describe("serializedByteLength", () => {
  it("measures bytes, not string length", () => {
    // The cap is about bytes on the wire; a CJK payload is ~3x its `.length`.
    const ascii = serializedByteLength({ a: "abc" })
    const cjk = serializedByteLength({ a: "中文字" })
    expect(ascii).toBe(11) // {"a":"abc"} — 11 chars, all ASCII
    expect(cjk).toBeGreaterThan(ascii!)
  })

  it("returns null for values JSON cannot represent", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(serializedByteLength(cyclic)).toBeNull()
    expect(serializedByteLength(() => {})).toBeNull()
  })

  it("measures at the cap boundary", () => {
    const under = { s: "x".repeat(MAX_PAYLOAD_BYTES - 100) }
    expect(serializedByteLength(under)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    const over = { s: "x".repeat(MAX_PAYLOAD_BYTES + 1) }
    expect(serializedByteLength(over)).toBeGreaterThan(MAX_PAYLOAD_BYTES)
  })
})
