import { createExternalAgentTraceBridge } from "./agent-trace-bridge"

describe("createExternalAgentTraceBridge (no-op stub)", () => {
  it("returns a bridge with all four lifecycle methods", () => {
    const bridge = createExternalAgentTraceBridge({
      sessionId: "s-1",
      agentId: "a-1",
    })
    expect(typeof bridge.onStart).toBe("function")
    expect(typeof bridge.onEvent).toBe("function")
    expect(typeof bridge.onComplete).toBe("function")
    expect(typeof bridge.onError).toBe("function")
  })

  it("each lifecycle method resolves with undefined", async () => {
    const bridge = createExternalAgentTraceBridge({
      sessionId: "s-1",
      agentId: "a-1",
      turnId: "t-1",
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "parent-1",
      tracestate: "vendor=ok",
      modelId: "claude",
      agentName: "Claude",
      protocol: "acp",
      transport: "stdio",
      acpSessionId: "acp-1",
      tags: ["external-agent"],
      metadata: { runtime: "test" },
    })
    await expect(bridge.onStart("hello")).resolves.toBeUndefined()
    await expect(bridge.onEvent({ type: "test" })).resolves.toBeUndefined()
    await expect(bridge.onComplete({ ok: true })).resolves.toBeUndefined()
    await expect(bridge.onError(new Error("boom"), { ctx: 1 })).resolves.toBeUndefined()
  })
})
