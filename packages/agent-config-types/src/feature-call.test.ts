import { isFeatureCallEvent, type ClaudeEvent, type FeatureCallRequest } from "./index"

describe("sidecar feature-call contract", () => {
  it("narrows correlated stream and terminal events", () => {
    expect(
      isFeatureCallEvent({
        type: "feature_call_stream",
        requestId: "request-1",
        part: { type: "text-delta", delta: "hello" },
      })
    ).toBe(true)
    expect(isFeatureCallEvent({ type: "ready" })).toBe(false)
  })

  it("carries typed Bedrock default-chain metadata", () => {
    const request: FeatureCallRequest = {
      requestId: "request-2",
      operation: "language-generate",
      providerId: "bedrock",
      model: "us.amazon.nova-lite-v1:0",
      credentials: {
        protocol: "bedrock",
        bedrockAuthMode: "default-chain",
        region: "us-east-1",
        profile: "engineering",
      },
    }
    expect(request.credentials.bedrockAuthMode).toBe("default-chain")
    expect(isFeatureCallEvent(request as unknown as ClaudeEvent)).toBe(false)
  })
})
