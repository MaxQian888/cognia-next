import { BUILT_IN_SKILL_CATALOG } from "./built-in-catalog"
import {
  BUILT_IN_CAPABILITY_RUNTIME_KEYS,
  builtInDescriptorSkill,
  resolveSkillDelivery,
} from "./delivery"

describe("resolveSkillDelivery", () => {
  it("injects an enabled surface skill and keeps its host policy when disabled", () => {
    const enabled = resolveSkillDelivery({
      surfaces: ["computer-use"],
      capabilities: { computerUse: { available: true } },
      skillStates: { "computer-use-safety": "enabled" },
    })
    expect(enabled.injected.map((skill) => skill.bundleId)).toEqual(["computer-use-safety"])
    expect(enabled.hostPolicies).toContain("host-consent")

    const disabled = resolveSkillDelivery({
      surfaces: ["computer-use"],
      skillStates: { "builtin:computer-use-safety": "disabled" },
    })
    expect(disabled.injected).toEqual([])
    expect(disabled.catalog).toEqual([])
    expect(disabled.hostPolicies).toContain("host-consent")
  })

  it("turns off automatic guidance without removing host policy or explicit skills", () => {
    const result = resolveSkillDelivery({
      surfaces: ["computer-use"],
      surfaceSkillsEnabled: false,
      explicitSkillIds: ["builtin:plugin-authoring"],
      capabilities: {
        workspace: { available: true },
        cogniaCli: { available: true },
      },
      skillStates: {
        "computer-use-safety": "enabled",
        skill_builtin_plugin_authoring: "enabled",
      },
    })
    expect(result.injected).toEqual([])
    expect(result.explicit.map((skill) => skill.bundleId)).toEqual(["plugin-authoring"])
    expect(result.hostPolicies).toContain("host-consent")
  })

  it("discovers contextual skills only when their capability is available", () => {
    const unavailable = resolveSkillDelivery({
      intents: ["chart", "diagram", "research-web"],
      skillStates: { "web-research": "enabled" },
      capabilities: {
        artifactAuthoring: { available: false, reason: "No artifact dock" },
        webSearch: { available: false, reason: "No search or fetch route" },
        webFetch: { available: false, reason: "No fetch route" },
      },
    })
    expect(unavailable.catalog).toEqual([])
    expect(unavailable.unavailable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bundleId: "chart-design", reason: "No artifact dock" }),
        expect.objectContaining({ bundleId: "web-research", reason: "No search or fetch route" }),
      ])
    )

    const available = resolveSkillDelivery({
      intents: ["chart", "diagram", "research-web"],
      skillStates: { "web-research": "enabled" },
      capabilities: {
        artifactAuthoring: { available: true },
        webSearch: { available: true },
        webFetch: { available: true },
      },
    })
    expect(available.catalog.map((skill) => skill.bundleId)).toEqual([
      "chart-design",
      "diagram-design",
      "web-research",
    ])
  })

  it("allows onboarding for its request even when the seeded row is not enabled", () => {
    const result = resolveSkillDelivery({
      intents: ["onboarding.summarize-web"],
      capabilities: { webFetch: { available: true } },
      requestScopedSkillIds: ["skill_builtin_cognia_onboarding"],
      skillStates: { "cognia-onboarding": "disabled" },
    })
    expect(result.requestScoped.map((skill) => skill.canonicalId)).toEqual([
      "builtin:cognia-onboarding",
    ])
  })

  it("fails closed when a request-scoped skill has no matching request intent", () => {
    const result = resolveSkillDelivery({
      requestScopedSkillIds: ["cognia-onboarding"],
    })
    expect(result.requestScoped).toEqual([])
    expect(result.unavailable).toContainEqual(
      expect.objectContaining({
        bundleId: "cognia-onboarding",
        reason: "Request-scoped Skill requires a matching intent",
      })
    )
  })

  it("never treats a disabled specialist skill as explicitly loadable", () => {
    const result = resolveSkillDelivery({
      explicitSkillIds: ["plugin-conversion"],
      skillStates: { "plugin-conversion": "disabled" },
    })
    expect(result.explicit).toEqual([])
    expect(result.unavailable).toContainEqual(
      expect.objectContaining({ bundleId: "plugin-conversion", reason: "Skill is disabled" })
    )
  })

  it("returns deterministic resource scope without inferring tool grants", () => {
    const result = resolveSkillDelivery({
      intents: ["diagram"],
      capabilities: { artifactAuthoring: { available: true } },
      explicitSkillIds: ["plugin-conversion"],
      skillStates: { "plugin-conversion": "enabled" },
    })
    expect(result.resourceSkillIds).toContain("skill_builtin_diagram_design")
  })

  it("maps every generated capability requirement to a runtime availability fact", () => {
    for (const entry of BUILT_IN_SKILL_CATALOG) {
      for (const requirement of entry.capabilityRequirements) {
        expect(BUILT_IN_CAPABILITY_RUNTIME_KEYS[requirement.capability]).toBeDefined()
      }
    }
  })

  it("projects a generated descriptor into the legacy scoped-loader shape", async () => {
    const result = resolveSkillDelivery({
      surfaces: ["computer-use"],
      capabilities: { computerUse: { available: true } },
    })
    await expect(builtInDescriptorSkill(result.injected[0]!)).resolves.toEqual(
      expect.objectContaining({
        id: "skill_builtin_computer_use_safety",
        slug: "computer-use-safety",
        canonicalId: "builtin:computer-use-safety",
        source: "builtin",
        status: "enabled",
      })
    )
  })

  it("has a reachable delivery result for every built-in descriptor", () => {
    const capabilities = Object.fromEntries(
      Object.values(BUILT_IN_CAPABILITY_RUNTIME_KEYS).map((key) => [key, { available: true }])
    )
    for (const entry of BUILT_IN_SKILL_CATALOG) {
      const result = resolveSkillDelivery({
        surfaces: entry.triggers.surfaces,
        intents: entry.triggers.intents,
        capabilities,
        skillStates: { [entry.id]: "enabled" },
        explicitSkillIds: entry.delivery === "explicit" ? [entry.canonicalId] : [],
        requestScopedSkillIds: entry.delivery === "request-scoped" ? [entry.id] : [],
      })
      const delivered = [
        ...result.injected,
        ...result.catalog,
        ...result.explicit,
        ...result.requestScoped,
      ]
      expect(delivered.map((skill) => skill.bundleId)).toContain(entry.id)
    }
  })
})
