import { videoRouteFacts } from "./route-facts"
import { nativeVideoRouteVerdict } from "./delivery-gate"

describe("videoRouteFacts", () => {
  it("opens the gate for a catalog Gemini model that declares video", () => {
    const facts = videoRouteFacts({ providerId: "google", modelId: "gemini-3.6-flash" })
    expect(facts).toMatchObject({
      providerId: "google",
      runtimeAdapter: "ai-sdk",
      protocol: "google",
      supportsVideo: true,
    })
    expect(nativeVideoRouteVerdict(facts)).toEqual({ available: true })
  })

  it("derives the runtime from the provider like dispatch does", () => {
    expect(
      videoRouteFacts({ providerId: "anthropic", modelId: "claude-opus-5" }).runtimeAdapter
    ).toBe("claude-agent-sdk")
    expect(videoRouteFacts({ providerId: undefined, modelId: "x" }).runtimeAdapter).toBe(
      "claude-agent-sdk"
    )
    expect(
      videoRouteFacts({
        providerId: "google",
        modelId: "gemini-3.6-flash",
        runtimeAdapter: "external",
      }).runtimeAdapter
    ).toBe("external")
  })

  it("reads a custom provider's protocol and per-model metadata", () => {
    const customProviders = [
      {
        id: "my-gemini",
        isCustom: true,
        customName: "My Gemini",
        name: "My Gemini",
        customModels: ["vid-1"],
        customModelMetadata: { "vid-1": { id: "vid-1", supportsVideo: true } },
        apiProtocol: "google",
        baseURL: "https://proxy.example/v1",
      },
    ] as never
    const facts = videoRouteFacts({ providerId: "my-gemini", modelId: "vid-1", customProviders })
    expect(facts.protocol).toBe("google")
    expect(facts.supportsVideo).toBe(true)
  })

  it("carries the conversation flags through as booleans", () => {
    const facts = videoRouteFacts({
      providerId: "google",
      modelId: "gemini-3.6-flash",
      teamRoom: true,
      standalone: undefined,
    })
    expect(facts.teamRoom).toBe(true)
    expect(facts.standalone).toBe(false)
    expect(nativeVideoRouteVerdict(facts)).toEqual({ available: false, reason: "team" })
  })

  it("knows nothing about a model without a provider", () => {
    expect(videoRouteFacts({ providerId: null, modelId: null })).toMatchObject({
      protocol: null,
      supportsVideo: false,
    })
  })
})
