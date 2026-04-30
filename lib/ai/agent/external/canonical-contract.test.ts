import {
  EXTERNAL_AGENT_CANONICAL_CONTRACT_VERSION,
  createUnknownSessionExtensionSupport,
  normalizeExternalAgentValiditySnapshot,
  validateExternalAgentBenchmarkCapabilityEntry,
  validateExternalAgentBenchmarkCapabilityMap,
  createExternalAgentBenchmarkBaseline,
} from "./canonical-contract"
import type { ExternalAgentBenchmarkCapabilityEntry } from "@/types/agent/external-agent"

describe("createUnknownSessionExtensionSupport", () => {
  it("returns the three method slots all in 'unknown' state", () => {
    const support = createUnknownSessionExtensionSupport()
    expect(support["session/list"].state).toBe("unknown")
    expect(support["session/fork"].state).toBe("unknown")
    expect(support["session/resume"].state).toBe("unknown")
  })
})

describe("normalizeExternalAgentValiditySnapshot — defaults", () => {
  it("fills in checkedAt, source, sessionExtensions, and capability snapshot", () => {
    const out = normalizeExternalAgentValiditySnapshot({})
    expect(out.checkedAt).toBeInstanceOf(Date)
    expect(out.source).toBe("config")
    expect(out.healthStatus).toBe("unknown")
    expect(out.sessionExtensions["session/list"].state).toBe("unknown")
    expect(out.contractVersion).toBe(EXTERNAL_AGENT_CANONICAL_CONTRACT_VERSION)
    expect(out.executionEligibility).toBe("eligible")
    expect(out.canonicalReasonCode).toBe("ok")
    expect(out.branchOutcome).toBe("external")
    expect(out.lifecycleStage).toBe("config")
    expect(out.capabilitySnapshot.protocol).toBe("acp")
    expect(out.recoveryHints).toEqual([])
  })

  it("uses fallbackProtocol when provided", () => {
    const out = normalizeExternalAgentValiditySnapshot(
      {},
      { fallbackProtocol: "opencode", fallbackSource: "health" }
    )
    expect(out.capabilitySnapshot.protocol).toBe("opencode")
    expect(out.source).toBe("health")
    expect(out.lifecycleStage).toBe("connect")
  })
})

describe("normalizeExternalAgentValiditySnapshot — reason resolution", () => {
  it("derives ecosystem_documented_only when executable=false and tier is documented-only", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      executable: false,
      ecosystem: {
        adapterId: "codex",
        supportTier: "documented-only",
        limitationNote: "Use the IDE extension",
      },
    })
    expect(out.canonicalReasonCode).toBe("ecosystem_documented_only")
    expect(out.canonicalReason).toBe("Use the IDE extension")
    expect(out.recoveryHints).toEqual(
      expect.arrayContaining(["Use the linked official product workflow for this surface."])
    )
  })

  it("falls back through ecosystem.recommendedActions when limitationNote is absent", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      executable: false,
      ecosystem: {
        adapterId: "codex",
        supportTier: "documented-only",
        recommendedActions: ["Click the docs link"],
      },
    })
    expect(out.canonicalReason).toBe("Click the docs link")
    expect(out.recoveryHints).toEqual(["Click the docs link"])
  })

  it("uses the documented-only fallback string when no other hint exists", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      executable: false,
      ecosystem: {
        adapterId: "codex",
        supportTier: "documented-only",
      },
    })
    expect(out.canonicalReason).toMatch(/documented but not directly executable/i)
  })

  it("derives ecosystem_prerequisite_missing from missing prerequisite detail", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      executable: false,
      ecosystem: {
        adapterId: "codex",
        supportTier: "executable",
        prerequisiteStatus: "action-required",
        prerequisites: [
          { id: "env", label: "ANTHROPIC_API_KEY", status: "missing", detail: "Set the env var" },
        ],
      },
    })
    expect(out.canonicalReasonCode).toBe("ecosystem_prerequisite_missing")
    expect(out.canonicalReason).toBe("Set the env var")
    expect(out.recoveryHints).toEqual([
      "Complete the required external-agent setup, then retry the connection.",
    ])
  })

  it("uses prerequisite.label when detail is missing", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      executable: false,
      ecosystem: {
        adapterId: "codex",
        supportTier: "executable",
        prerequisiteStatus: "action-required",
        prerequisites: [{ id: "env", label: "API key required", status: "missing" }],
      },
    })
    expect(out.canonicalReason).toBe("API key required")
  })

  it("respects an explicit canonicalReasonCode without overriding it", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      canonicalReasonCode: "permission_denied",
      canonicalReason: "User declined",
    })
    expect(out.canonicalReasonCode).toBe("permission_denied")
    expect(out.canonicalReason).toBe("User declined")
  })

  it("uses blockingReasonCode then lastBranchReasonCode as fallback", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({ blockingReasonCode: "transport_blocked" })
        .canonicalReasonCode
    ).toBe("transport_blocked")
    expect(
      normalizeExternalAgentValiditySnapshot({ lastBranchReasonCode: "execution_failed" })
        .canonicalReasonCode
    ).toBe("execution_failed")
  })
})

describe("normalizeExternalAgentValiditySnapshot — branch outcome inference", () => {
  it("returns 'strict_failure' for the strict_failure reason", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({
        canonicalReasonCode: "strict_failure",
      }).branchOutcome
    ).toBe("strict_failure")
  })

  it("returns 'fallback' for fallback_to_builtin", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({
        canonicalReasonCode: "fallback_to_builtin",
      }).branchOutcome
    ).toBe("fallback")
  })

  it("returns 'builtin' for agent_not_found and configuration_missing", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({ canonicalReasonCode: "agent_not_found" })
        .branchOutcome
    ).toBe("builtin")
    expect(
      normalizeExternalAgentValiditySnapshot({
        canonicalReasonCode: "configuration_missing",
      }).branchOutcome
    ).toBe("builtin")
  })

  it("returns 'blocked' when execution is blocked", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({ executable: false, canonicalReasonCode: "ok" })
        .branchOutcome
    ).toBe("blocked")
  })

  it("respects an explicit branch outcome", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({ branchOutcome: "external" }).branchOutcome
    ).toBe("external")
  })
})

describe("normalizeExternalAgentValiditySnapshot — lifecycle stage mapping", () => {
  it("maps source 'connect' and 'health' to 'connect' stage", () => {
    expect(normalizeExternalAgentValiditySnapshot({ source: "connect" }).lifecycleStage).toBe(
      "connect"
    )
    expect(normalizeExternalAgentValiditySnapshot({ source: "health" }).lifecycleStage).toBe(
      "connect"
    )
  })

  it("maps source 'execution' (default fallback) to 'execution'", () => {
    expect(normalizeExternalAgentValiditySnapshot({ source: "execution" }).lifecycleStage).toBe(
      "execution"
    )
  })

  it("maps fallback outcome to 'fallback' stage", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({
        canonicalReasonCode: "fallback_to_builtin",
      }).lifecycleStage
    ).toBe("fallback")
  })

  it("maps strict_failure outcome to 'recovery' stage", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({
        canonicalReasonCode: "strict_failure",
      }).lifecycleStage
    ).toBe("recovery")
  })

  it("respects an explicit lifecycleStage override", () => {
    expect(
      normalizeExternalAgentValiditySnapshot({ lifecycleStage: "session_extensions" })
        .lifecycleStage
    ).toBe("session_extensions")
  })
})

describe("normalizeExternalAgentValiditySnapshot — recovery hints map", () => {
  const cases: Array<[string, string]> = [
    ["protocol_unsupported", "Switch agent protocol to ACP."],
    ["transport_blocked", "Run Cognia in desktop (Tauri) runtime for stdio transport."],
    ["initialization_failed", "Check ACP process command and startup arguments."],
    ["health_check_failed", "Inspect external-agent health endpoint/logs."],
    ["extension_unsupported", "Use operations supported by this endpoint."],
    [
      "session_resolution_failed",
      "Resume with an existing session id or allow new session creation.",
    ],
    ["permission_denied", "Adjust permission mode or approve required actions."],
    ["execution_failed", "Check runtime diagnostics and retry with scoped input."],
  ]

  for (const [reason, hint] of cases) {
    it(`emits a recovery hint for ${reason}`, () => {
      const out = normalizeExternalAgentValiditySnapshot({
        canonicalReasonCode: reason as never,
      })
      expect(out.recoveryHints).toEqual(expect.arrayContaining([hint]))
    })
  }

  it("prefers ecosystem.recommendedActions when present", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      canonicalReasonCode: "permission_denied",
      ecosystem: {
        adapterId: "codex",
        supportTier: "executable",
        recommendedActions: ["Click here", "Or there"],
      },
    })
    expect(out.recoveryHints).toEqual(["Click here", "Or there"])
  })

  it("respects an explicit recoveryHints override", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      canonicalReasonCode: "permission_denied",
      recoveryHints: ["custom"],
    })
    expect(out.recoveryHints).toEqual(["custom"])
  })
})

describe("normalizeExternalAgentValiditySnapshot — capability + correlation", () => {
  it("uses negotiation.protocol when present", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      negotiation: { protocol: "opencode", authRequired: true, agentCapabilities: { foo: true } },
    })
    expect(out.capabilitySnapshot.protocol).toBe("opencode")
    expect(out.capabilitySnapshot.authRequired).toBe(true)
    expect(out.capabilitySnapshot.hasAgentCapabilities).toBe(true)
  })

  it("respects explicit capabilitySnapshot", () => {
    const explicit = {
      protocol: "acp" as const,
      authRequired: false,
      hasAgentCapabilities: false,
      sessionExtensions: createUnknownSessionExtensionSupport(),
    }
    const out = normalizeExternalAgentValiditySnapshot({ capabilitySnapshot: explicit })
    expect(out.capabilitySnapshot).toBe(explicit)
  })

  it("includes correlation when a reason exists", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      canonicalReasonCode: "execution_failed",
      canonicalReason: "boom",
    })
    expect(out.correlation?.source).toBe("manager")
    expect(out.correlation?.observedAt).toBeInstanceOf(Date)
  })

  it("respects an explicit correlation passthrough", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      correlation: { source: "manager", sessionId: "s1", observedAt: new Date(0) },
    })
    expect(out.correlation?.sessionId).toBe("s1")
  })
})

describe("validateExternalAgentBenchmarkCapabilityEntry", () => {
  function baseEntry(
    overrides: Partial<ExternalAgentBenchmarkCapabilityEntry> = {}
  ): ExternalAgentBenchmarkCapabilityEntry {
    return {
      id: "test",
      title: "T",
      referenceBehavior: "ref",
      cogniaBehavior: "cog",
      adaptationTarget: "tgt",
      gapGrade: "minor",
      status: "validated",
      owner: "ext",
      evidence: [{ id: "e1", kind: "test", summary: "s", reference: "r", recordedAt: new Date() }],
      updatedAt: new Date(),
      ...overrides,
    }
  }

  it("flags validated entries with no evidence", () => {
    const result = validateExternalAgentBenchmarkCapabilityEntry(baseEntry({ evidence: [] }))
    expect(result.valid).toBe(false)
    expect(result.errors[0]).toMatch(/no executable evidence/)
  })

  it("flags missing deviation record on intentional-deviation entries", () => {
    const result = validateExternalAgentBenchmarkCapabilityEntry(
      baseEntry({ status: "intentional-deviation", evidence: [] })
    )
    expect(result.valid).toBe(false)
    expect(result.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/deviation record is missing/)])
    )
  })

  it("flags incomplete deviation fields", () => {
    const result = validateExternalAgentBenchmarkCapabilityEntry(
      baseEntry({
        status: "intentional-deviation",
        evidence: [],
        deviation: {
          rationale: "  ",
          tradeOff: "",
          userImpact: "",
          review: { reviewedBy: "", reviewedAt: "not a date" as unknown as Date },
        },
      })
    )
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(5)
  })

  it("returns valid for a fully-formed deviation entry", () => {
    const result = validateExternalAgentBenchmarkCapabilityEntry(
      baseEntry({
        status: "intentional-deviation",
        evidence: [],
        deviation: {
          rationale: "x",
          tradeOff: "y",
          userImpact: "z",
          review: { reviewedBy: "qa", reviewedAt: new Date() },
        },
      })
    )
    expect(result.valid).toBe(true)
  })

  it("returns valid for the default validated entry", () => {
    expect(validateExternalAgentBenchmarkCapabilityEntry(baseEntry()).valid).toBe(true)
  })
})

describe("validateExternalAgentBenchmarkCapabilityMap", () => {
  it("aggregates per-entry errors", () => {
    const entries = createExternalAgentBenchmarkBaseline()
    // Force one entry into an invalid validated-without-evidence state
    entries[1].evidence = []
    const result = validateExternalAgentBenchmarkCapabilityMap(entries)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it("returns valid when all entries are valid", () => {
    const baseline = createExternalAgentBenchmarkBaseline()
    expect(validateExternalAgentBenchmarkCapabilityMap(baseline).valid).toBe(true)
  })
})

describe("createExternalAgentBenchmarkBaseline", () => {
  it("returns the four canonical baseline entries", () => {
    const baseline = createExternalAgentBenchmarkBaseline()
    expect(baseline.length).toBe(4)
    expect(baseline.map((e) => e.id)).toEqual([
      "acp-validity-canonical-projection",
      "session-extension-operation-gating",
      "routing-fallback-diagnostics-consistency",
      "session-resume-fallback-policy-deviation",
    ])
  })

  it("uses the supplied 'now' for timestamps", () => {
    const fixed = new Date("2025-06-01T00:00:00Z")
    const baseline = createExternalAgentBenchmarkBaseline(fixed)
    for (const entry of baseline) {
      expect(entry.updatedAt).toBe(fixed)
    }
  })
})
