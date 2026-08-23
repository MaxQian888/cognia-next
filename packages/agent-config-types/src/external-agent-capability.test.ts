import { AGENT_CAPABILITY_IDS } from "./agent-execution"
import {
  BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS,
  EXTERNAL_AGENT_CAPABILITY_IDS,
  EXTERNAL_ONLY_CAPABILITY_IDS,
  LEGACY_EXTERNAL_AGENT_PROTOCOLS,
  UNKNOWN_CAPABILITY_SPEC_REASON,
  hostCeilingsCapabilityLayer,
  hostFactsCapabilityLayer,
  isBuiltinExecutableExternalAgentProtocol,
  isCapabilityUsable,
  isLegacyExternalAgentProtocol,
  isPluginExternalAgentProtocol,
  isSelectableExternalAgentProtocol,
  mergeExternalAgentCapabilities,
  missingExternalAgentCapabilities,
  parsePluginExternalAgentProtocol,
  projectExternalAgentCapabilitiesToSpec,
  sanitizePluginCapabilityMatrix,
  usableExternalAgentCapabilities,
  type ExternalAgentCapabilityCell,
  type ExternalAgentCapabilityId,
  type ExternalAgentCapabilityProfileV1,
} from "./external-agent-capability"

const cell = (
  level: ExternalAgentCapabilityCell["level"],
  evidence: ExternalAgentCapabilityCell["evidence"] = "protocol-spec",
  reasonKey?: string
): ExternalAgentCapabilityCell => ({ level, evidence, ...(reasonKey ? { reasonKey } : {}) })

function profileFrom(
  effective: Partial<Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell>>,
  protocol = "acp"
): ExternalAgentCapabilityProfileV1 {
  const full = {} as Record<ExternalAgentCapabilityId, ExternalAgentCapabilityCell>
  for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
    full[id] = effective[id] ?? cell("unknown", "none")
  }
  return {
    profileVersion: 1,
    protocol,
    manifestVersion: 1,
    declared: {},
    live: {},
    hostFacts: {
      toolHostRunning: false,
      subagentDispatchProjected: false,
      hookRuntimeAvailable: false,
    },
    ceilings: { sandboxAvailable: true },
    effective: full,
    drift: [],
    negotiated: true,
    digest: "test",
  }
}

describe("protocol vocabulary", () => {
  it("registers exactly the seven protocols that have an adapter", () => {
    expect([...BUILTIN_EXECUTABLE_EXTERNAL_AGENT_PROTOCOLS].sort()).toEqual([
      "a2a",
      "acp",
      "codex-app-server",
      "dsh-sdk",
      "opencode",
      "opencode-v2",
      "pi-rpc",
    ])
  })

  it("keeps legacy protocols readable but never selectable", () => {
    for (const legacy of LEGACY_EXTERNAL_AGENT_PROTOCOLS) {
      expect(isLegacyExternalAgentProtocol(legacy)).toBe(true)
      expect(isBuiltinExecutableExternalAgentProtocol(legacy)).toBe(false)
      expect(isSelectableExternalAgentProtocol(legacy)).toBe(false)
    }
  })

  it("parses a plugin protocol into its two ids", () => {
    expect(parsePluginExternalAgentProtocol("my-plugin:demo")).toEqual({
      pluginId: "my-plugin",
      adapterId: "demo",
    })
    expect(isSelectableExternalAgentProtocol("my-plugin:demo")).toBe(true)
  })

  it("rejects malformed plugin protocols instead of truncating them", () => {
    // A traversal-flavoured adapter id and a three-segment value are the two
    // ways a namespaced id could be smuggled past a naive split(":")[0].
    expect(parsePluginExternalAgentProtocol("evil:../../x")).toBeNull()
    expect(parsePluginExternalAgentProtocol("a:b:c")).toBeNull()
    expect(parsePluginExternalAgentProtocol("acp")).toBeNull()
    expect(parsePluginExternalAgentProtocol("-bad:demo")).toBeNull()
    expect(isPluginExternalAgentProtocol("acp")).toBe(false)
  })
})

describe("capability vocabulary", () => {
  it("is the v2 closed set plus the external-only ids", () => {
    expect(EXTERNAL_AGENT_CAPABILITY_IDS).toHaveLength(
      AGENT_CAPABILITY_IDS.length + EXTERNAL_ONLY_CAPABILITY_IDS.length
    )
    for (const id of AGENT_CAPABILITY_IDS) expect(EXTERNAL_AGENT_CAPABILITY_IDS).toContain(id)
  })

  it("never lets `unknown` satisfy a requirement", () => {
    expect(isCapabilityUsable("native")).toBe(true)
    expect(isCapabilityUsable("equivalent")).toBe(true)
    expect(isCapabilityUsable("unknown")).toBe(false)
    expect(isCapabilityUsable("unsupported")).toBe(false)
  })
})

describe("mergeExternalAgentCapabilities", () => {
  it("applies layers in declaration order regardless of argument order", () => {
    const { effective } = mergeExternalAgentCapabilities([
      { layer: "live", cells: { steer: cell("native", "handshake") } },
      {
        layer: "protocol",
        cells: { steer: cell("unsupported", "protocol-spec", "noProtocolSlot") },
      },
    ])
    expect(effective.steer).toEqual(cell("native", "handshake"))
  })

  it("lets a static refinement fill an unknown", () => {
    const { effective, drift } = mergeExternalAgentCapabilities([
      { layer: "protocol", cells: { compaction: cell("unknown", "none") } },
      {
        layer: "refinement",
        cells: { compaction: cell("equivalent", "adapter-code", "viaCommand") },
      },
    ])
    expect(effective.compaction?.level).toBe("equivalent")
    expect(drift).toEqual([])
  })

  it("refuses to let a static refinement widen a protocol refusal", () => {
    const { effective } = mergeExternalAgentCapabilities([
      { layer: "protocol", cells: { mcp: cell("unsupported", "protocol-spec", "noProtocolSlot") } },
      { layer: "refinement", cells: { mcp: cell("native", "protocol-spec") } },
    ])
    expect(effective.mcp?.level).toBe("unsupported")
  })

  it("lets a static refinement tighten", () => {
    const { effective } = mergeExternalAgentCapabilities([
      { layer: "protocol", cells: { streaming: cell("native") } },
      {
        layer: "refinement",
        cells: { streaming: cell("unsupported", "vendor-certified", "committedRepliesOnly") },
      },
    ])
    expect(effective.streaming?.level).toBe("unsupported")
  })

  it("lets a live fact overrule a stale declaration and records the drift", () => {
    const { effective, drift } = mergeExternalAgentCapabilities([
      { layer: "protocol", cells: { "session.resume": cell("native") } },
      {
        layer: "live",
        cells: { "session.resume": cell("unsupported", "handshake", "notNegotiated") },
      },
    ])
    expect(effective["session.resume"]?.level).toBe("unsupported")
    expect(drift).toEqual([
      {
        capability: "session.resume",
        declaredLevel: "native",
        observedLevel: "unsupported",
        observedBy: "live",
      },
    ])
  })

  it("does not report drift when a live fact merely fills an unknown", () => {
    const { drift } = mergeExternalAgentCapabilities([
      { layer: "protocol", cells: { streaming: cell("unknown", "none") } },
      { layer: "live", cells: { streaming: cell("native", "handshake") } },
    ])
    expect(drift).toEqual([])
  })

  it("intersects at the ceiling and never widens there", () => {
    const { effective } = mergeExternalAgentCapabilities([
      {
        layer: "protocol",
        cells: { mcp: cell("native"), steer: cell("unsupported", "protocol-spec", "x") },
      },
      {
        layer: "ceiling",
        cells: { mcp: cell("unsupported", "adapter-code", "noSandbox"), steer: cell("native") },
      },
    ])
    expect(effective.mcp?.level).toBe("unsupported")
    expect(effective.steer?.level).toBe("unsupported")
  })

  it("treats an unmentioned ceiling capability as untouched", () => {
    const { effective } = mergeExternalAgentCapabilities([
      { layer: "protocol", cells: { mcp: cell("native") } },
      { layer: "ceiling", cells: {} },
    ])
    expect(effective.mcp?.level).toBe("native")
  })
})

describe("host layers", () => {
  it("grants Cognia-provided capabilities through the live layer, not the ceiling", () => {
    const layer = hostFactsCapabilityLayer({
      toolHostRunning: true,
      subagentDispatchProjected: true,
      hookRuntimeAvailable: true,
    })
    expect(layer.layer).toBe("live")
    expect(layer.cells["hooks.lifecycle"]?.level).toBe("equivalent")
    expect(layer.cells["subagents.model-selection"]?.level).toBe("equivalent")
  })

  it("blames the tool host when dispatch never reached the agent", () => {
    const layer = hostFactsCapabilityLayer({
      toolHostRunning: false,
      subagentDispatchProjected: true,
      hookRuntimeAvailable: false,
    })
    expect(layer.cells["subagents.model-selection"]).toEqual({
      level: "unsupported",
      evidence: "probe",
      reasonKey: "noToolHost",
    })
    expect(layer.cells["hooks.lifecycle"]?.reasonKey).toBe("noHookRuntime")
  })

  it("clamps everything when the platform cannot sandbox", () => {
    const layer = hostCeilingsCapabilityLayer({ sandboxAvailable: false })
    for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
      expect(layer.cells[id]).toEqual({
        level: "unsupported",
        evidence: "adapter-code",
        reasonKey: "noSandbox",
      })
    }
  })

  it("clamps nothing when the platform can sandbox", () => {
    expect(hostCeilingsCapabilityLayer({ sandboxAvailable: true }).cells).toEqual({})
  })
})

describe("profile helpers", () => {
  it("reports only usable levels", () => {
    const profile = profileFrom({
      streaming: cell("native"),
      mcp: cell("equivalent", "adapter-code", "bridge"),
      steer: cell("unsupported", "adapter-code", "adapterMethodMissing"),
    })
    const usable = usableExternalAgentCapabilities(profile)
    expect(usable).toContain("streaming")
    expect(usable).toContain("mcp")
    expect(usable).not.toContain("steer")
    expect(usable).not.toContain("checkpoint")
  })

  it("fails an unknown hard requirement closed, with the cell attached", () => {
    const profile = profileFrom({ streaming: cell("native") })
    expect(missingExternalAgentCapabilities(profile, ["streaming"])).toEqual([])
    const missing = missingExternalAgentCapabilities(profile, ["mcp"])
    expect(missing).toHaveLength(1)
    expect(missing[0].capability).toBe("mcp")
    expect(missing[0].cell.level).toBe("unknown")
  })
})

describe("projectExternalAgentCapabilitiesToSpec", () => {
  it("drops the external-only ids rather than widening the v2 contract", () => {
    const profile = profileFrom({
      streaming: cell("native"),
      "models.list": cell("native"),
      "mcp.logs": cell("native"),
    })
    const projection = projectExternalAgentCapabilitiesToSpec(profile)
    expect(projection.effective).toContain("streaming")
    expect(projection.effective as string[]).not.toContain("models.list")
    expect(projection.support as Record<string, unknown>).not.toHaveProperty("mcp.logs")
  })

  it("projects unknown as unsupported with a machine-readable reason", () => {
    const projection = projectExternalAgentCapabilitiesToSpec(profileFrom({}))
    expect(projection.support.mcp?.support).toBe("unsupported")
    expect(projection.support.mcp?.reason).toContain(UNKNOWN_CAPABILITY_SPEC_REASON)
    expect(projection.support.mcp?.reason).toContain("acp/mcp")
  })

  it("keeps `equivalent` distinct from `native` and explains it", () => {
    const projection = projectExternalAgentCapabilitiesToSpec(
      profileFrom({ mcp: cell("equivalent", "adapter-code", "perThreadConfigOverride") })
    )
    expect(projection.support.mcp?.support).toBe("equivalent")
    expect(projection.support.mcp?.reason).toContain("perThreadConfigOverride")
    expect(projection.effective).toContain("mcp")
    expect(projection.support.streaming?.support).toBe("unsupported")
  })

  it("leaves a native cell unexplained — there is nothing to explain", () => {
    const projection = projectExternalAgentCapabilitiesToSpec(
      profileFrom({ streaming: cell("native") })
    )
    expect(projection.support.streaming).toEqual({ support: "native" })
  })
})

describe("sanitizePluginCapabilityMatrix", () => {
  it("keeps a well-formed declaration intact", () => {
    expect(
      sanitizePluginCapabilityMatrix({
        streaming: { level: "native", evidence: "protocol-spec" },
        mcp: {
          level: "equivalent",
          evidence: "adapter-code",
          reasonKey: "perThreadConfigOverride",
        },
      })
    ).toEqual({
      streaming: { level: "native", evidence: "protocol-spec" },
      mcp: { level: "equivalent", evidence: "adapter-code", reasonKey: "perThreadConfigOverride" },
    })
  })

  it("drops a level outside the vocabulary", () => {
    // The one that matters: `PERMISSIVENESS["yes"]` is `undefined`, so
    // `stricter()` compares `undefined < n` (always false) and the ceiling
    // layer silently stops clamping that cell.
    expect(
      sanitizePluginCapabilityMatrix({ mcp: { level: "yes", evidence: "adapter-code" } })
    ).toEqual({})
  })

  it("refuses to let a plugin self-certify the strongest evidence grades", () => {
    expect(
      sanitizePluginCapabilityMatrix({
        mcp: { level: "native", evidence: "cognia-verified" },
        streaming: { level: "native", evidence: "vendor-certified" },
        thinking: { level: "native", evidence: "handshake" },
      })
    ).toEqual({
      mcp: { level: "native", evidence: "adapter-code" },
      streaming: { level: "native", evidence: "adapter-code" },
      thinking: { level: "native", evidence: "adapter-code" },
    })
  })

  it("drops unknown ids, non-object cells and junk input", () => {
    expect(
      sanitizePluginCapabilityMatrix({
        "not-a-capability": { level: "native", evidence: "adapter-code" },
        mcp: "native",
        streaming: null,
      })
    ).toEqual({})
    expect(sanitizePluginCapabilityMatrix(undefined)).toEqual({})
    expect(sanitizePluginCapabilityMatrix("nope")).toEqual({})
  })

  it("holds a declaration to the manifest's own reason and evidence discipline", () => {
    // An unexplained refusal is indistinguishable from an unfinished adapter,
    // and `none` admits nothing was measured so it cannot back a verdict.
    expect(
      sanitizePluginCapabilityMatrix({ mcp: { level: "unsupported", evidence: "adapter-code" } })
    ).toEqual({})
    expect(sanitizePluginCapabilityMatrix({ mcp: { level: "native", evidence: "none" } })).toEqual(
      {}
    )
    expect(sanitizePluginCapabilityMatrix({ mcp: { level: "unknown", evidence: "none" } })).toEqual(
      {
        mcp: { level: "unknown", evidence: "none" },
      }
    )
  })

  it("a dropped cell reads as `unknown`, never as a granted capability", () => {
    const { effective } = mergeExternalAgentCapabilities([
      {
        layer: "protocol",
        cells: { mcp: { level: "unknown", evidence: "none", reasonKey: "noManifestRow" } },
      },
      { layer: "refinement", cells: sanitizePluginCapabilityMatrix({ mcp: { level: "yes" } }) },
    ])
    expect(effective.mcp?.level).toBe("unknown")
    expect(isCapabilityUsable(effective.mcp!.level)).toBe(false)
  })
})
