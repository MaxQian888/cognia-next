import { liveCapabilityFacts } from "./capability-live-facts"

describe("liveCapabilityFacts", () => {
  it("produces nothing when the handshake reported nothing", () => {
    expect(liveCapabilityFacts({})).toEqual({})
  })

  it("records what the agent explicitly advertised", () => {
    const cells = liveCapabilityFacts({
      negotiated: { streaming: true, multiTurn: true, thinking: true },
    })
    expect(cells.streaming).toEqual({
      level: "native",
      evidence: "handshake",
      reasonKey: "negotiatedStreaming",
    })
    // `thinking` is NOT among them: the flag means "streams chain-of-thought",
    // while the capability asks whether the host can set the reasoning level.
    // Answering the second with the first widened a correct manifest row —
    // `live` is the only layer allowed to widen — and opened `/think` on a
    // backend with nothing to forward the pick to.
    expect(cells.thinking).toBeUndefined()
  })

  it("reads `multiTurn` as the RESUME capability it is actually set from", () => {
    // `acp-client.ts` sets `multiTurn` from `agentCapabilities.loadSession`.
    // Its name says multi-turn; its value says resume.
    const cells = liveCapabilityFacts({ negotiated: { multiTurn: true } })
    expect(cells["session.resume"]?.level).toBe("native")
    expect(cells["session.multi-turn"]).toBeUndefined()
  })

  it("records an explicit refusal", () => {
    const cells = liveCapabilityFacts({ negotiated: { streaming: false, multiTurn: false } })
    expect(cells.streaming?.level).toBe("unsupported")
    expect(cells["session.resume"]?.level).toBe("unsupported")
  })

  it("treats an OMITTED mcpTools flag as no evidence, not as a refusal", () => {
    // Every shipped ACP preset omits the flag, and the codebase has always
    // read that omission as "the protocol slot exists". Emitting an
    // `unsupported` cell here would let a silent handshake overrule a correct
    // manifest row and break all of them at once.
    expect(liveCapabilityFacts({ negotiated: { streaming: true } }).mcp).toBeUndefined()
    expect(liveCapabilityFacts({ negotiated: { mcpTools: true } }).mcp).toBeUndefined()
    expect(liveCapabilityFacts({ negotiated: { mcpTools: false } })?.mcp?.level).toBe("unsupported")
  })

  it("propagates a tool-execution refusal to results and errors", () => {
    const cells = liveCapabilityFacts({ negotiated: { toolExecution: false } })
    expect(cells["tools.ordinary"]?.level).toBe("unsupported")
    expect(cells["tools.results"]?.level).toBe("unsupported")
    expect(cells["tools.errors"]?.level).toBe("unsupported")
  })

  it("answers compaction from the advertised command list", () => {
    expect(
      liveCapabilityFacts({ availableCommands: [{ name: "compact", description: "" }] }).compaction
    ).toEqual({
      level: "equivalent",
      evidence: "handshake",
      reasonKey: "advertisedCompactCommand",
    })
    expect(
      liveCapabilityFacts({ availableCommands: [{ name: "help", description: "" }] }).compaction
        ?.level
    ).toBe("unsupported")
  })

  it("says nothing about compaction when no command list has arrived", () => {
    expect(liveCapabilityFacts({ negotiated: { streaming: true } }).compaction).toBeUndefined()
  })
})
