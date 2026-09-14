import {
  NATIVE_VIDEO_MAX_BYTES,
  nativeVideoRouteVerdict,
  nativeVideoVerdict,
  resolveVideoRouteProtocol,
  type VideoRouteFacts,
} from "./delivery-gate"

const gemini: VideoRouteFacts = {
  providerId: "google",
  modelId: "gemini-3.6-flash",
  runtimeAdapter: "ai-sdk",
  protocol: "google",
  supportsVideo: true,
}

describe("nativeVideoRouteVerdict", () => {
  it("opens for a video-capable Gemini model on the ai-sdk runtime", () => {
    expect(nativeVideoRouteVerdict(gemini)).toEqual({ available: true })
  })

  it.each([
    [{ platformBound: true }, "platform"],
    [{ teamRoom: true }, "team"],
    [{ sharedCollaboration: true }, "shared"],
    [{ externalAgent: true }, "external-agent"],
    [{ runtimeAdapter: "external" as const }, "external-agent"],
    [{ standalone: true }, "standalone"],
    [{ autoRouting: true }, "auto-routing"],
    [{ runtimeAdapter: "claude-agent-sdk" as const }, "runtime"],
    [{ protocol: "openai" }, "protocol"],
    [{ protocol: null }, "protocol"],
    [{ supportsVideo: false }, "model"],
  ])("closes for %o with reason %s", (override, reason) => {
    expect(nativeVideoRouteVerdict({ ...gemini, ...override })).toEqual({
      available: false,
      reason,
    })
  })

  it("does not open for an openai-compatible model that declares video", () => {
    expect(
      nativeVideoRouteVerdict({
        providerId: "moonshot",
        modelId: "kimi-k2.6",
        runtimeAdapter: "ai-sdk",
        protocol: "openai",
        supportsVideo: true,
      })
    ).toEqual({ available: false, reason: "protocol" })
  })

  it("reports what the user cannot change before the model choice", () => {
    expect(
      nativeVideoRouteVerdict({ ...gemini, teamRoom: true, supportsVideo: false, protocol: null })
    ).toEqual({ available: false, reason: "team" })
  })
})

describe("nativeVideoVerdict", () => {
  it("adds the byte ceiling on top of the route", () => {
    expect(nativeVideoVerdict(gemini, 1024)).toEqual({ available: true })
    expect(nativeVideoVerdict(gemini, NATIVE_VIDEO_MAX_BYTES + 1)).toEqual({
      available: false,
      reason: "too-large",
    })
    expect(nativeVideoVerdict(gemini, 0)).toEqual({ available: false, reason: "too-large" })
  })

  it("keeps a route refusal over a size refusal", () => {
    expect(nativeVideoVerdict({ ...gemini, supportsVideo: false }, Infinity)).toEqual({
      available: false,
      reason: "model",
    })
  })
})

describe("resolveVideoRouteProtocol", () => {
  it("uses the sidecar's table for built-in providers, normalising aliases", () => {
    expect(resolveVideoRouteProtocol("google", "gemini-3.6-flash")).toBe("google")
    expect(resolveVideoRouteProtocol("gemini", "gemini-3.6-flash")).toBe("google")
    expect(resolveVideoRouteProtocol("anthropic", "claude-opus-5")).toBe("anthropic")
  })

  it("prefers a custom provider's declared protocol", () => {
    expect(
      resolveVideoRouteProtocol("my-gemini-proxy", "gemini", [
        { id: "my-gemini-proxy", apiProtocol: "gemini" },
      ])
    ).toBe("google")
    expect(
      resolveVideoRouteProtocol("my-proxy", "x", [{ id: "my-proxy", apiProtocol: "openai" }])
    ).toBe("openai")
  })

  it("is null when nothing is known", () => {
    expect(resolveVideoRouteProtocol(undefined, "x")).toBeNull()
    expect(resolveVideoRouteProtocol("not-a-provider", "x")).toBeNull()
  })
})
