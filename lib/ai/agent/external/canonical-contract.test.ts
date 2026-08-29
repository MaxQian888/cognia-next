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
    expect(out.capabilitySnapshot!.protocol).toBe("acp")
    expect(out.recoveryHints).toEqual([])
  })

  it("uses fallbackProtocol when provided", () => {
    const out = normalizeExternalAgentValiditySnapshot(
      {},
      { fallbackProtocol: "opencode", fallbackSource: "health" }
    )
    expect(out.capabilitySnapshot!.protocol).toBe("opencode")
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
    expect(out.recoveryHints).toEqual(expect.arrayContaining(["useOfficialWorkflow"]))
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
    // `canonicalReason` is prose by contract, so falling back to the ecosystem's
    // first recommended action is right. `recoveryHints` are i18n key ids, so
    // they stay keyed off the reason code — the two fields are not a pair.
    expect(out.canonicalReason).toBe("Click the docs link")
    expect(out.recoveryHints).toEqual(["useOfficialWorkflow", "selectLocalSurface"])
  })

  it("skips a message-reference action when reaching for a prose reason", () => {
    // `canonicalReason` is prose by contract. A `{ id }` entry is a message
    // key, so taking [0] blindly would put a raw id — or `[object Object]` —
    // in front of the user.
    const out = normalizeExternalAgentValiditySnapshot({
      executable: false,
      ecosystem: {
        adapterId: "codex",
        supportTier: "documented-only",
        recommendedActions: [{ id: "installHintCodex" }, "Read the runbook first."],
      },
    })
    expect(out.canonicalReason).toBe("Read the runbook first.")
  })

  it("falls through to the documented-only default when every action is a reference", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      executable: false,
      ecosystem: {
        adapterId: "codex",
        supportTier: "documented-only",
        recommendedActions: [{ id: "installHintCodex" }, { id: "codexWsl2" }],
      },
    })
    expect(out.canonicalReason).toBe(
      "This official surface is documented but not directly executable in Cognia yet."
    )
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
    expect(out.recoveryHints).toEqual(["completeSetupThenRetry"])
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
  // Hints are i18n key ids, not prose: they are produced in `lib/`, which has no
  // locale, and resolved by the renderer against `diagnostics.recoveryHint.*`.
  // Asserting on ids is also what keeps a copy edit from breaking this suite.
  const cases: Array<[string, string]> = [
    ["protocol_unsupported", "switchToAcp"],
    ["transport_blocked", "useDesktopRuntime"],
    ["initialization_failed", "checkCommandAndArgs"],
    ["health_check_failed", "inspectHealthEndpoint"],
    ["extension_unsupported", "useSupportedOperations"],
    ["session_resolution_failed", "resumeWithSessionIdOrAllowNew"],
    ["permission_denied", "adjustPermissionMode"],
    ["execution_failed", "checkDiagnosticsAndRetry"],
    // The administrator's standing limit. Distinct from `permission_denied`,
    // which a person can answer during the turn.
    ["managed_policy_refused", "useAllowedSandboxOrApproval"],
  ]

  for (const [reason, hint] of cases) {
    it(`emits a recovery hint for ${reason}`, () => {
      const out = normalizeExternalAgentValiditySnapshot({
        canonicalReasonCode: reason as never,
      })
      expect(out.recoveryHints).toEqual(expect.arrayContaining([hint]))
    })
  }

  it("emits only ids that the diagnostics namespace can resolve", () => {
    // The gap this closes: a hint id with no translation would render as the
    // raw id — the same class of leak as the untranslated reason-code badge.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const messages = require("@/i18n/messages/en.json") as {
      diagnostics: { recoveryHint: Record<string, string> }
    }
    const reasons = [
      "ecosystem_prerequisite_missing",
      "ecosystem_documented_only",
      "protocol_unsupported",
      "transport_blocked",
      "initialization_failed",
      "health_check_failed",
      "extension_unsupported",
      "session_resolution_failed",
      "permission_denied",
      "execution_failed",
      "managed_policy_refused",
    ]
    const emitted = reasons.flatMap(
      (reason) =>
        normalizeExternalAgentValiditySnapshot({ canonicalReasonCode: reason as never })
          .recoveryHints ?? []
    )
    expect(emitted.length).toBeGreaterThan(0)
    expect(emitted.filter((id) => !(id in messages.diagnostics.recoveryHint))).toEqual([])
  })

  it("keeps recovery hints as key ids even when the ecosystem has prose advice", () => {
    // Substituting `recommendedActions` here is what broke the localized
    // advice: the panel resolves every hint through
    // `t(`recoveryHint.${id}`)`, so English prose fell through that lookup and
    // printed verbatim into a Chinese UI. The two survive as separate fields
    // and the panel renders them on separate lines.
    const out = normalizeExternalAgentValiditySnapshot({
      canonicalReasonCode: "permission_denied",
      ecosystem: {
        adapterId: "codex",
        supportTier: "executable",
        recommendedActions: ["Click here", "Or there"],
      },
    })
    expect(out.recoveryHints).toEqual(["adjustPermissionMode"])
    expect(out.ecosystem?.recommendedActions).toEqual(["Click here", "Or there"])
  })

  it("still lets a caller override the hints outright", () => {
    const out = normalizeExternalAgentValiditySnapshot({
      canonicalReasonCode: "permission_denied",
      ecosystem: {
        adapterId: "codex",
        supportTier: "executable",
        recommendedActions: ["Click here"],
      },
      recoveryHints: ["custom"],
    })
    expect(out.recoveryHints).toEqual(["custom"])
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
      negotiation: {
        protocol: "opencode",
        authRequired: true,
        agentCapabilities: { loadSession: true },
      },
    })
    expect(out.capabilitySnapshot!.protocol).toBe("opencode")
    expect(out.capabilitySnapshot!.authRequired).toBe(true)
    expect(out.capabilitySnapshot!.hasAgentCapabilities).toBe(true)
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
  it("returns the canonical baseline entries", () => {
    const baseline = createExternalAgentBenchmarkBaseline()
    expect(baseline.length).toBe(11)
    expect(baseline.map((e) => e.id)).toEqual([
      "acp-validity-canonical-projection",
      "session-extension-operation-gating",
      "routing-fallback-diagnostics-consistency",
      "session-resume-fallback-policy-deviation",
      "codex-failure-error-event-parity",
      "codex-session-extension-deterministic-gating",
      "opencode-session-extension-connection-gated",
      "a2a-surface-reachability",
      "a2a-task-protocol-projection-scope",
      "acp-usage-context-window-only",
      "codex-agent-auth-env-based",
    ])
  })

  it("keeps every baseline entry valid (each gap resolved or reviewed)", () => {
    const baseline = createExternalAgentBenchmarkBaseline()
    const result = validateExternalAgentBenchmarkCapabilityMap(baseline)
    expect(result.valid).toBe(true)
    // Every entry is either a validated capability or a fully-reviewed deviation.
    for (const entry of baseline) {
      if (entry.status === "validated") {
        expect(entry.evidence.length).toBeGreaterThan(0)
      }
      if (entry.status === "intentional-deviation") {
        expect(entry.deviation?.rationale).toBeTruthy()
        expect(entry.deviation?.review.reviewedBy).toBeTruthy()
      }
    }
  })

  it("uses the supplied 'now' for timestamps", () => {
    const fixed = new Date("2025-06-01T00:00:00Z")
    const baseline = createExternalAgentBenchmarkBaseline(fixed)
    for (const entry of baseline) {
      expect(entry.updatedAt).toBe(fixed)
    }
  })
})
