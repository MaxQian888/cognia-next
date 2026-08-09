import {
  isExplicitlyUnsupportedCapabilityError,
  resolveCommandCompactionCapability,
  resolveProviderUndoCapability,
} from "./session-capabilities"

describe("external-agent session capabilities", () => {
  it("recognizes only advertised compact and compress commands", () => {
    const capability = resolveCommandCompactionCapability([
      { name: "/summarize", description: "Summarize" },
      { name: "compress-fast", description: "Prune without a model" },
      { name: "/compress", description: "Compress context", input: { hint: "focus" } },
      { name: "compact", description: "Compact context" },
    ])

    expect(capability).toEqual({
      status: "supported",
      routes: [
        {
          kind: "command",
          command: "compress",
          supportsFocus: true,
        },
      ],
    })
  })

  it("reports unsupported when no compaction command is advertised", () => {
    expect(
      resolveCommandCompactionCapability([{ name: "handoff", description: "Start a handoff" }])
    ).toEqual({ status: "unsupported", routes: [] })
  })

  it("exposes provider undo only for an exact advertised undo command", () => {
    expect(
      resolveProviderUndoCapability([
        { name: "/undo", description: "Undo the provider's last change" },
      ])
    ).toEqual({
      status: "supported",
      command: "undo",
    })
    expect(
      resolveProviderUndoCapability([{ name: "undo-last", description: "Not the same command" }])
    ).toEqual({ status: "unsupported" })
  })

  it("allows fallback only for explicit unsupported-operation errors", () => {
    expect(isExplicitlyUnsupportedCapabilityError({ status: 404 })).toBe(false)
    expect(
      isExplicitlyUnsupportedCapabilityError({
        status: 404,
        message: "Unsupported endpoint",
      })
    ).toBe(true)
    expect(isExplicitlyUnsupportedCapabilityError({ code: -32601 })).toBe(true)
    expect(isExplicitlyUnsupportedCapabilityError({ code: "CAPABILITY_UNAVAILABLE" })).toBe(true)
    expect(isExplicitlyUnsupportedCapabilityError(new Error("Method not found"))).toBe(true)
    expect(isExplicitlyUnsupportedCapabilityError(new Error("Request timed out"))).toBe(false)
    expect(isExplicitlyUnsupportedCapabilityError(new Error("Provider model not found"))).toBe(
      false
    )
    expect(
      isExplicitlyUnsupportedCapabilityError({
        status: 404,
        code: "MODEL_NOT_FOUND",
        message: "Provider model not found",
      })
    ).toBe(false)
    expect(isExplicitlyUnsupportedCapabilityError({ status: 401, message: "Unauthorized" })).toBe(
      false
    )
    expect(isExplicitlyUnsupportedCapabilityError(new Error("Context overflow"))).toBe(false)
  })
})
