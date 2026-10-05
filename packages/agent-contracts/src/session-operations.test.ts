import {
  isExplicitlyUnsupportedCapabilityError,
  resolveCommandCompactionCapability,
  resolveProviderUndoCapability,
  resolveSessionOperationCapabilities,
  type ExternalAgentNativeCompactionRoute,
} from "./session-operations"

describe("external-agent session capabilities", () => {
  it.each([true, false])(
    "allows native providers to advertise focus support (%s)",
    (supportsFocus) => {
      const route: ExternalAgentNativeCompactionRoute = { kind: "native", supportsFocus }
      expect(route.supportsFocus).toBe(supportsFocus)
    }
  )

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

describe("session operation discovery", () => {
  it("never advertises a missing implementation, even when a provider declares support", () => {
    const capabilities = resolveSessionOperationCapabilities(
      {},
      {
        inputQueue: "supported",
        forkAtEntry: "supported",
      }
    )
    expect(Object.values(capabilities).every((status) => status === "unsupported")).toBe(true)
  })

  it("does not equate whole-session forks with forks at an entry", () => {
    const adapter = { forkSession: async () => {}, enqueueSessionInput: async () => {} }
    expect(resolveSessionOperationCapabilities(adapter)).toMatchObject({
      forkAtEntry: "unsupported",
      inputQueue: "supported",
      shell: "unsupported",
    })
    expect(
      resolveSessionOperationCapabilities(adapter, { forkAtEntry: "supported" })
    ).toMatchObject({
      forkAtEntry: "supported",
    })
  })

  it("honors provider negotiation failures rather than method presence alone", () => {
    expect(
      resolveSessionOperationCapabilities(
        { getSessionTree: async () => {} },
        {
          tree: "unknown",
        }
      ).tree
    ).toBe("unknown")
    expect(
      resolveSessionOperationCapabilities(
        { getSessionTree: async () => {} },
        {
          tree: "unsupported",
        }
      ).tree
    ).toBe("unsupported")
  })
})

it("requires explicit background turn support as well as a native event subscription", () => {
  const adapter = { subscribeSessionEvents: () => () => {} }
  expect(resolveSessionOperationCapabilities(adapter).backgroundTurns).toBe("unsupported")
  expect(
    resolveSessionOperationCapabilities(adapter, { backgroundTurns: "supported" }).backgroundTurns
  ).toBe("supported")
  expect(
    resolveSessionOperationCapabilities({}, { backgroundTurns: "supported" }).backgroundTurns
  ).toBe("unsupported")
})
