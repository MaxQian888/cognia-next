import {
  ACP_PROTOCOL_REGISTRY,
  AcpWireValidationError,
  classifyAcpV1Method,
  validateAcpV1Envelope,
} from "./acp-wire-codec"

describe("ACP v1 wire codec", () => {
  it("uses the official SDK protocol version and keeps v2 unadvertised", () => {
    expect(ACP_PROTOCOL_REGISTRY.v1.protocolVersion).toBe(1)
    expect(ACP_PROTOCOL_REGISTRY.v1.advertised).toBe(true)
    expect(ACP_PROTOCOL_REGISTRY.v2.advertised).toBe(false)
  })

  it("classifies stable, gated, legacy, and future methods independently", () => {
    expect(classifyAcpV1Method("session/new")).toBe("stable")
    expect(classifyAcpV1Method("session/update")).toBe("stable")
    expect(classifyAcpV1Method("$/cancel_request")).toBe("stable")
    expect(classifyAcpV1Method("elicitation/create")).toBe("feature_gated")
    expect(classifyAcpV1Method("mcp/connect")).toBe("feature_gated")
    expect(classifyAcpV1Method("nes/suggest")).toBe("feature_gated")
    expect(classifyAcpV1Method("session/set_model")).toBe("legacy")
    expect(classifyAcpV1Method("vendor/future_method")).toBe("future")
  })

  it("preserves unknown metadata and fields while validating the JSON-RPC envelope", () => {
    const input = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "future_update", vendor: true },
        _meta: { vendor: { trace: 1 } },
      },
      vendorEnvelopeField: "preserved",
    }

    expect(validateAcpV1Envelope(input)).toBe(input)
  })

  it.each([
    null,
    {},
    { jsonrpc: "1.0", method: "session/update" },
    { jsonrpc: "2.0", id: null, method: "session/update" },
    { jsonrpc: "2.0", id: {}, result: {} },
    { jsonrpc: "2.0", id: 1, result: {}, error: { code: -1, message: "both" } },
  ])("rejects malformed envelopes: %p", (input) => {
    expect(() => validateAcpV1Envelope(input)).toThrow(AcpWireValidationError)
  })
})
