import { EXTERNAL_AGENT_CAPABILITY_IDS } from "@cognia/agent-config-types/external-agent-capability"

import {
  NO_HOST_FACTS,
  buildDeclaredCapabilityProfile,
  computeExternalAgentProfileDigest,
  negotiateCapabilityProfile,
} from "./capability-profile"

describe("buildDeclaredCapabilityProfile", () => {
  it("is complete and explicitly un-negotiated", () => {
    const profile = buildDeclaredCapabilityProfile({ protocol: "acp" })
    expect(profile.negotiated).toBe(false)
    expect(profile.live).toEqual({})
    for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
      expect(profile.effective[id]).toBeDefined()
    }
  })

  it("does not invent adapter-method verdicts before an adapter exists", () => {
    // Pi's manifest row says nothing about session management, so the only
    // possible answer is the adapter-method layer — which the static phase has
    // no instance for. Answering it here would be the pre-handshake guess the
    // two-phase split exists to remove.
    const profile = buildDeclaredCapabilityProfile({ protocol: "pi-rpc" })
    expect(profile.effective["session.manage"].level).toBe("unknown")
  })

  it("applies the preset refinement", () => {
    const profile = buildDeclaredCapabilityProfile({
      protocol: "acp",
      presetId: "deepseek-harness-acp",
    })
    expect(profile.effective.streaming.level).toBe("unsupported")
    expect(profile.effective.streaming.reasonKey).toBe("committedRepliesOnly")
  })

  it("leaves every agent-owned capability unknown for a plugin protocol with no declaration", () => {
    const profile = buildDeclaredCapabilityProfile({
      protocol: "acme:weird",
      pluginId: "acme",
      adapterId: "weird",
    })
    // `hooks.lifecycle` and `subagents.model-selection` are answered by the
    // HOST, not the agent, so an undeclared plugin protocol still gets a real
    // verdict for them — here `unsupported`, because the default host facts
    // say Cognia provides nothing.
    const hostAnswered = new Set(["hooks.lifecycle", "subagents.model-selection"])
    for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
      expect(`${id}=${profile.effective[id].level}`).toBe(
        `${id}=${hostAnswered.has(id) ? "unsupported" : "unknown"}`
      )
    }
  })

  it("accepts a plugin declaration but never lets it widen a protocol refusal", () => {
    const declared = buildDeclaredCapabilityProfile({
      protocol: "acp",
      pluginDeclaration: {
        "models.list": { level: "native", evidence: "vendor-certified" },
        "tools.parallel": { level: "native", evidence: "vendor-certified" },
      },
    })
    // ACP has no model-list method at the protocol level, and a plugin
    // shipping a preset cannot overrule that.
    expect(declared.effective["models.list"].level).toBe("unsupported")
    // …but it can fill in what the manifest never measured.
    expect(declared.effective["tools.parallel"].level).toBe("native")
  })

  it("clamps every capability when the platform cannot sandbox", () => {
    const unclamped = buildDeclaredCapabilityProfile({ protocol: "acp" })
    const profile = buildDeclaredCapabilityProfile({
      protocol: "acp",
      ceilings: { sandboxAvailable: false },
    })
    for (const id of EXTERNAL_AGENT_CAPABILITY_IDS) {
      expect(`${id}=${profile.effective[id].level}`).toBe(`${id}=unsupported`)
      // A capability that was ALREADY refused keeps its own, more specific
      // reason — the sandbox is why the agent cannot run at all, which the
      // preflight reports once, not 44 times.
      if (unclamped.effective[id].level !== "unsupported") {
        expect(profile.effective[id].reasonKey).toBe("noSandbox")
      }
    }
  })
})

describe("negotiateCapabilityProfile", () => {
  const adapter = { steerTurn: () => undefined, resumeSession: () => undefined }

  it("marks itself negotiated only when live facts were supplied", () => {
    expect(negotiateCapabilityProfile({ protocol: "acp", adapter }).negotiated).toBe(false)
    expect(negotiateCapabilityProfile({ protocol: "acp", adapter, liveFacts: {} }).negotiated).toBe(
      true
    )
  })

  it("resolves adapter-method capabilities from the instance", () => {
    const profile = negotiateCapabilityProfile({
      protocol: "codex-app-server",
      adapter,
      liveFacts: {},
    })
    expect(profile.effective.steer.level).toBe("native")
    expect(profile.effective["session.resume"].level).toBe("native")
    // `turn/steer` and `session.resume` are in the schema AND wired; setting a
    // model is in the schema and this adapter does not call it, so the row is
    // tightened rather than trusted.
    expect(profile.effective["set-model"].level).toBe("unsupported")
    expect(profile.effective["set-model"].reasonKey).toBe("adapterMethodMissing")
  })

  it("never lets a present method widen a protocol that has no such slot", () => {
    // ACP has no mid-turn input method. An adapter that grew a `steerTurn`
    // anyway does not give the protocol one.
    const profile = negotiateCapabilityProfile({ protocol: "acp", adapter, liveFacts: {} })
    expect(profile.effective.steer.level).toBe("unsupported")
    expect(profile.effective.steer.reasonKey).toBe("noProtocolSlot")
  })

  it("lets the handshake overrule a stale declaration and records the drift", () => {
    const profile = negotiateCapabilityProfile({
      protocol: "acp",
      adapter,
      liveFacts: {
        streaming: { level: "unsupported", evidence: "handshake", reasonKey: "notNegotiated" },
      },
    })
    expect(profile.effective.streaming.level).toBe("unsupported")
    expect(profile.drift).toEqual([
      {
        capability: "streaming",
        declaredLevel: "native",
        observedLevel: "unsupported",
        observedBy: "live",
      },
    ])
  })

  it("lets a handshake fact beat a host fact for the same capability", () => {
    const profile = negotiateCapabilityProfile({
      protocol: "acp",
      adapter,
      hostFacts: {
        toolHostRunning: true,
        subagentDispatchProjected: true,
        hookRuntimeAvailable: true,
      },
      liveFacts: {
        "hooks.lifecycle": {
          level: "unsupported",
          evidence: "handshake",
          reasonKey: "agentRefused",
        },
      },
    })
    expect(profile.effective["hooks.lifecycle"].level).toBe("unsupported")
    expect(profile.effective["subagents.model-selection"].level).toBe("equivalent")
  })

  it("keeps `declared` free of live and host facts so drift stays visible", () => {
    const profile = negotiateCapabilityProfile({
      protocol: "acp",
      adapter,
      hostFacts: {
        toolHostRunning: true,
        subagentDispatchProjected: true,
        hookRuntimeAvailable: true,
      },
      liveFacts: { streaming: { level: "unsupported", evidence: "handshake", reasonKey: "x" } },
    })
    expect(profile.declared.streaming?.level).toBe("native")
    expect(profile.declared["hooks.lifecycle"]?.level).toBe("unknown")
    expect(profile.hostFacts.hookRuntimeAvailable).toBe(true)
  })
})

describe("computeExternalAgentProfileDigest", () => {
  const base = () =>
    negotiateCapabilityProfile({
      protocol: "acp",
      presetId: "claude-code",
      adapter: { steerTurn: () => undefined },
      liveFacts: {},
    })

  it("is stable for the same inputs", () => {
    expect(base().digest).toBe(base().digest)
  })

  it("changes when the effective matrix changes", () => {
    const withSteer = negotiateCapabilityProfile({
      protocol: "codex-app-server",
      adapter: { steerTurn: () => undefined },
      liveFacts: {},
    })
    const withoutSteer = negotiateCapabilityProfile({
      protocol: "codex-app-server",
      adapter: {},
      liveFacts: {},
    })
    expect(withSteer.digest).not.toBe(withoutSteer.digest)
  })

  it("distinguishes a pre-handshake profile from a negotiated one that agrees", () => {
    const declared = buildDeclaredCapabilityProfile({ protocol: "a2a", presetId: undefined })
    const negotiated = negotiateCapabilityProfile({ protocol: "a2a", liveFacts: {} })
    expect(negotiated.effective).toEqual(declared.effective)
    expect(negotiated.digest).not.toBe(declared.digest)
  })

  it("ignores drift, which is a report about the route and not the answer", () => {
    const withDrift = negotiateCapabilityProfile({
      protocol: "acp",
      liveFacts: { streaming: { level: "native", evidence: "handshake" } },
    })
    const withoutDrift = negotiateCapabilityProfile({ protocol: "acp", liveFacts: {} })
    expect(withDrift.effective.streaming).toEqual({ level: "native", evidence: "handshake" })
    expect(withoutDrift.effective.streaming).toEqual({ level: "native", evidence: "protocol-spec" })
    // The digest hashes the merged CELLS, evidence included, so these differ —
    // the guard here is that `drift` itself is not what made them differ.
    expect(computeExternalAgentProfileDigest({ ...withDrift, drift: [] })).toBe(
      computeExternalAgentProfileDigest(withDrift)
    )
  })

  it("does not depend on the host facts beyond their effect on the matrix", () => {
    const a = negotiateCapabilityProfile({
      protocol: "acp",
      hostFacts: NO_HOST_FACTS,
      liveFacts: {},
    })
    const b = negotiateCapabilityProfile({
      protocol: "acp",
      hostFacts: {
        toolHostRunning: false,
        subagentDispatchProjected: true,
        hookRuntimeAvailable: false,
      },
      liveFacts: {},
    })
    expect(b.digest).toBe(a.digest)
  })
})
