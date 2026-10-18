import {
  isExplicitlyUnsupportedCapabilityError,
  resolveCommandCompactionCapability,
  resolveProviderUndoCapability,
  resolveSessionOperationCapabilities,
  type ExternalAgentNativeCompactionRoute,
  requestedRuntimeCapabilities,
  runtimeFeatureValidationError,
  runtimeFeaturePolicyKey,
} from "./session-operations"

describe("portable runtime feature intent", () => {
  it("uses a stable retention key for policy semantics and preserves default compatibility", () => {
    expect(runtimeFeaturePolicyKey({})).toBeUndefined()
    expect(
      runtimeFeaturePolicyKey({ subagentRuntime: { contextMode: "isolated" } })
    ).toBeUndefined()
    const a = {
      toolPermissionRules: [
        { tool: "mcp__notes__write", decision: "ask" as const },
        { tool: "mcp__notes__delete", decision: "deny" as const },
      ],
    }
    expect(runtimeFeaturePolicyKey(a)).toBe(
      runtimeFeaturePolicyKey({ toolPermissionRules: [...a.toolPermissionRules].reverse() })
    )
    expect(runtimeFeaturePolicyKey(a)).not.toBe(
      runtimeFeaturePolicyKey({
        toolPermissionRules: [{ tool: "mcp__notes__write", decision: "deny" }],
      })
    )
    expect(
      runtimeFeatureValidationError({
        runtimeExtensions: [{ kind: "directory", path: "relative" }],
      })
    ).toBe("invalid_runtime_extensions")
  })

  it("requires support only for explicitly requested features", () => {
    expect(requestedRuntimeCapabilities({ subagentRuntime: { contextMode: "isolated" } })).toEqual(
      []
    )
    expect(
      requestedRuntimeCapabilities({
        subagentRuntime: { contextMode: "fork" },
        agents: { child: { contextPolicy: { compactAtTokens: 1000 } } },
        toolPermissionRules: [{ tool: "mcp__notes__write", decision: "ask" }],
      })
    ).toEqual(["subagents.context-fork", "subagents.auto-compaction", "tools.permission-policy"])
  })
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid compaction window %s",
    (compactAtTokens) => {
      expect(
        runtimeFeatureValidationError({ agents: { child: { contextPolicy: { compactAtTokens } } } })
      ).toBe("invalid_subagent_compaction_window")
    }
  )
  it("accepts positive windows and refuses malformed policy envelopes", () => {
    expect(
      runtimeFeatureValidationError({
        agents: { child: { contextPolicy: { compactAtTokens: 1 } } },
      })
    ).toBeNull()
    expect(
      runtimeFeatureValidationError({ toolPermissionRules: [{ tool: "", decision: "ask" }] })
    ).toBe("invalid_tool_permission_rules")
    expect(runtimeFeatureValidationError({ agents: { child: null } } as never)).toBe(
      "invalid_subagent_compaction_window"
    )
  })
})

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
