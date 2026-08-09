import { normalizeAcpElicitationRequest, validateAcpElicitationResponse } from "./acp-elicitation"

describe("ACP elicitation validation", () => {
  it("accepts a restricted flat form schema and preserves metadata", () => {
    const result = normalizeAcpElicitationRequest("rpc-1", {
      mode: "form",
      sessionId: "session-1",
      message: "Choose settings",
      requestedSchema: {
        type: "object",
        properties: {
          model: { type: "string", oneOf: [{ const: "fast", title: "Fast" }] },
          trace: { type: "boolean", title: "Trace" },
        },
        required: ["model"],
      },
      _meta: { vendor: { opaque: true } },
    })

    expect(result).toMatchObject({
      ok: true,
      request: {
        id: "rpc-1",
        mode: "form",
        sessionId: "session-1",
        _meta: { vendor: { opaque: true } },
      },
    })
  })

  it.each([
    ["nested object", { type: "object" }],
    ["password format", { type: "string", format: "password" }],
    ["write-only field", { type: "string", writeOnly: true }],
  ])("rejects %s form fields", (_label, property) => {
    const result = normalizeAcpElicitationRequest("rpc-2", {
      mode: "form",
      sessionId: "session-1",
      message: "Unsafe",
      requestedSchema: {
        type: "object",
        properties: { credential: property },
      },
    })

    expect(result.ok).toBe(false)
  })

  it("rejects secret-like fields even when disguised as plain strings", () => {
    const result = normalizeAcpElicitationRequest("rpc-secret", {
      mode: "form",
      sessionId: "session-1",
      message: "Credentials",
      requestedSchema: {
        type: "object",
        properties: { apiToken: { type: "string" } },
      },
    })

    expect(result.ok).toBe(false)
  })

  it("accepts only https URLs and exposes punycode warnings without fetching", () => {
    expect(
      normalizeAcpElicitationRequest("rpc-3", {
        mode: "url",
        requestId: 7,
        message: "Sign in",
        elicitationId: "auth-1",
        url: "https://xn--pple-43d.example/login",
      })
    ).toMatchObject({
      ok: true,
      request: { origin: "https://xn--pple-43d.example", hasPunycodeWarning: true },
    })

    expect(
      normalizeAcpElicitationRequest("rpc-4", {
        mode: "url",
        requestId: 7,
        message: "Sign in",
        elicitationId: "auth-2",
        url: "http://example.com/login",
      })
    ).toMatchObject({ ok: false })
  })

  it("does not treat future modes as known behavior", () => {
    expect(
      normalizeAcpElicitationRequest("rpc-5", {
        mode: "future_mode",
        sessionId: "session-1",
        message: "Future",
        payload: { opaque: true },
      })
    ).toMatchObject({ ok: false, reason: "unsupported_mode" })
  })

  it("validates accepted content against the requested primitive types", () => {
    const normalized = normalizeAcpElicitationRequest("rpc-6", {
      mode: "form",
      sessionId: "session-1",
      message: "Settings",
      requestedSchema: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
      },
    })
    if (!normalized.ok) throw new Error("expected valid request")

    expect(
      validateAcpElicitationResponse(normalized.request, {
        requestId: "rpc-6",
        action: "accept",
        content: { enabled: true },
      })
    ).toEqual({ action: "accept", content: { enabled: true } })
    expect(() =>
      validateAcpElicitationResponse(normalized.request, {
        requestId: "rpc-6",
        action: "accept",
        content: { enabled: "yes" },
      })
    ).toThrow("enabled")
  })
})
