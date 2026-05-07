import { computeRuntimeAvailability } from "./use-runtime-availability"

describe("computeRuntimeAvailability", () => {
  it("flags claude as missing-key when no API key is set", () => {
    const map = computeRuntimeAvailability({
      apiKey: "",
      agents: [],
      connectionStatus: {},
    })
    expect(map.claude).toBe("missing-key")
  })

  it("flags claude as ready when an API key is saved", () => {
    const map = computeRuntimeAvailability({
      apiKey: "sk-ant-x",
      agents: [],
      connectionStatus: {},
    })
    expect(map.claude).toBe("ready")
  })

  it("returns no-agent for external runtimes without a configured preset", () => {
    const map = computeRuntimeAvailability({
      apiKey: undefined,
      agents: [],
      connectionStatus: {},
    })
    expect(map.codex).toBe("no-agent")
    expect(map["claude-code"]).toBe("no-agent")
    expect(map["gemini-cli"]).toBe("no-agent")
    expect(map["cursor-cli"]).toBe("no-agent")
  })

  it("returns disconnected when a matching agent exists but is not connected", () => {
    const map = computeRuntimeAvailability({
      apiKey: undefined,
      agents: [{ id: "a1", enabled: true, metadata: { preset: "codex" } }],
      connectionStatus: { a1: "disconnected" },
    })
    expect(map.codex).toBe("disconnected")
  })

  it("returns ready when matching agent is enabled and connected", () => {
    const map = computeRuntimeAvailability({
      apiKey: undefined,
      agents: [{ id: "a1", enabled: true, metadata: { preset: "claude-code" } }],
      connectionStatus: { a1: "connected" },
    })
    expect(map["claude-code"]).toBe("ready")
  })

  it("ignores disabled agents", () => {
    const map = computeRuntimeAvailability({
      apiKey: undefined,
      agents: [{ id: "a1", enabled: false, metadata: { preset: "codex" } }],
      connectionStatus: { a1: "connected" },
    })
    expect(map.codex).toBe("no-agent")
  })

  it("matches by metadata.preset, not by id", () => {
    const map = computeRuntimeAvailability({
      apiKey: undefined,
      agents: [{ id: "x", enabled: true, metadata: { preset: "gemini-cli" } }],
      connectionStatus: { x: "connected" },
    })
    expect(map["gemini-cli"]).toBe("ready")
    expect(map.codex).toBe("no-agent")
  })
})
