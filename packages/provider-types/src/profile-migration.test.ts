import { getBuiltInProviderCatalog } from "./built-in-provider-catalog"
import {
  builtinEndpointSentinel,
  deriveProfiles,
  exportProfilesRedacted,
  importProfiles,
  upgradeDeploymentProfileCatalogRefs,
  type DeriveProfilesInput,
} from "./profile-migration"

const catalog = getBuiltInProviderCatalog()

const SENTINEL_KEY = "sk-live-SENTINEL-abc123"

function fixtureInput(): DeriveProfilesInput {
  return {
    catalog,
    providerSettings: {
      zhipu: { providerId: "zhipu", enabled: true, apiKey: SENTINEL_KEY, defaultModel: "glm-4.6" },
      "glm-anthropic": {
        providerId: "glm-anthropic",
        enabled: true,
        apiKey: SENTINEL_KEY,
      },
      "glm-anthropic-intl": { providerId: "glm-anthropic-intl", enabled: false },
      moonshot: { providerId: "moonshot", enabled: true, apiKey: SENTINEL_KEY },
      "kimi-anthropic": { providerId: "kimi-anthropic", enabled: true },
      minimax: { providerId: "minimax", enabled: true },
      "minimax-anthropic": { providerId: "minimax-anthropic", enabled: true },
      anthropic: { providerId: "anthropic", enabled: true, apiKey: SENTINEL_KEY },
      "rotation-pool": {
        providerId: "rotation-pool",
        enabled: true,
        apiKeys: [SENTINEL_KEY, "sk-live-SENTINEL-def456"],
        baseURL: "https://pool.example/v1",
      },
    },
    customProviders: [
      {
        id: "my-claude-relay",
        name: "My Claude Relay",
        enabled: true,
        protocol: "anthropic",
        baseURL: "https://relay.example/anthropic",
        defaultModel: "claude-sonnet-5",
        models: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5-20251001" }],
        customHeaders: { "x-tenant": "team-1", authorization: "Bearer leak-me" },
      },
    ],
  }
}

describe("deriveProfiles", () => {
  it("folds relays under their vendor while keeping deployment ids identical to legacy ids", () => {
    const derived = deriveProfiles(fixtureInput())

    const zhipu = derived.providerProfiles.find((p) => p.id === "zhipu")
    expect(zhipu?.deploymentRefs).toEqual(["glm-anthropic", "glm-anthropic-intl", "zhipu"])

    const moonshot = derived.providerProfiles.find((p) => p.id === "moonshot")
    expect(moonshot?.deploymentRefs).toEqual(["kimi-anthropic", "moonshot"])

    const minimax = derived.providerProfiles.find((p) => p.id === "minimax")
    expect(minimax?.deploymentRefs).toEqual(["minimax", "minimax-anthropic"])

    // No new relay-shaped provider ids: relays exist only as deployments.
    expect(derived.providerProfiles.map((p) => p.id)).not.toContain("glm-anthropic")

    const glm = derived.deploymentProfiles.find((d) => d.id === "glm-anthropic")
    expect(glm).toMatchObject({
      providerRef: "zhipu",
      legacyProviderId: "glm-anthropic",
      credentialProfileRef: { kind: "legacy-provider-settings", providerId: "glm-anthropic" },
    })
    expect(glm?.endpoint).toContain("bigmodel.cn")

    // Disabled rows keep their identity but carry enabled: false.
    const intl = derived.deploymentProfiles.find((d) => d.id === "glm-anthropic-intl")
    expect(intl?.enabled).toBe(false)
  })

  it("derives shared protocol transports and per-deployment header transports", () => {
    const derived = deriveProfiles(fixtureInput())

    const anthropicShared = derived.transportProfiles.find((t) => t.id === "tp-anthropic-x-api-key")
    expect(anthropicShared).toMatchObject({ protocol: "anthropic", auth: { scheme: "x-api-key" } })
    const openaiShared = derived.transportProfiles.find((t) => t.id === "tp-openai-bearer")
    expect(openaiShared).toMatchObject({ protocol: "openai", auth: { scheme: "bearer" } })

    // Custom provider with headers gets its own transport; the blocked
    // authorization header is stripped by the policy, the benign one kept.
    const custom = derived.transportProfiles.find((t) => t.id === "tp-my-claude-relay")
    expect(custom?.staticHeaders).toEqual({ "x-tenant": "team-1" })
    const customDeployment = derived.deploymentProfiles.find((d) => d.id === "my-claude-relay")
    expect(customDeployment?.transportProfileRef).toBe("tp-my-claude-relay")
  })

  it("is deterministic and idempotent (same input ⇒ deep-equal output)", () => {
    const first = deriveProfiles(fixtureInput())
    const second = deriveProfiles(fixtureInput())
    expect(second).toEqual(first)
  })

  it("never copies secret material into any derived document", () => {
    const serialized = JSON.stringify(deriveProfiles(fixtureInput()))
    expect(serialized).not.toContain("SENTINEL")
    expect(serialized).not.toContain("leak-me")
    expect(serialized.toLowerCase()).not.toContain('"apikey"')
  })

  it("tolerates empty/partial inputs and unknown provider ids", () => {
    expect(deriveProfiles({ catalog })).toEqual({
      providerProfiles: [],
      deploymentProfiles: [],
      transportProfiles: [],
      legacyAliases: {},
    })

    const unknown = deriveProfiles({
      catalog,
      providerSettings: { "mystery-provider": { providerId: "mystery-provider", enabled: true } },
      customProviders: [{ name: "no-id-row" }],
    })
    const deployment = unknown.deploymentProfiles.find((d) => d.id === "mystery-provider")
    expect(deployment?.endpoint).toBe(builtinEndpointSentinel("mystery-provider"))
    expect(deployment?.transportProfileRef).toBe("tp-openai-bearer")
    // The id-less custom row is skipped, not crashed on.
    expect(unknown.deploymentProfiles).toHaveLength(1)
  })

  it("keeps an identity-preserving legacy alias for every migrated row", () => {
    const derived = deriveProfiles(fixtureInput())
    for (const deployment of derived.deploymentProfiles) {
      expect(derived.legacyAliases[deployment.id]).toBe(deployment.id)
    }
  })

  it("writes catalog references for every migrated deployment model", () => {
    const derived = deriveProfiles(fixtureInput())
    for (const deployment of derived.deploymentProfiles) {
      for (const model of deployment.models) {
        expect(model).toMatchObject({
          upstreamId: model.id,
          offeringRef: `${deployment.id}:${model.id}`,
          canonicalModelRef: expect.any(String),
        })
      }
    }

    const glm = derived.deploymentProfiles.find((item) => item.id === "glm-anthropic")
    expect(glm?.models.find((model) => model.id === "glm-4.6")?.canonicalModelRef).toBe(
      "zhipu:glm-4.6"
    )
  })

  it("idempotently upgrades v1 deployment models without replacing existing references", () => {
    const v1 = {
      id: "openrouter-main",
      providerRef: "openrouter",
      endpoint: "https://openrouter.ai/api/v1",
      transportProfileRef: "tp-openai-bearer",
      models: [{ id: "openai/gpt-test" }],
    }
    const upgraded = upgradeDeploymentProfileCatalogRefs(v1)
    expect(upgraded.models[0]).toEqual({
      id: "openai/gpt-test",
      upstreamId: "openai/gpt-test",
      offeringRef: "openrouter-main:openai/gpt-test",
      canonicalModelRef: "openai:gpt-test",
    })
    expect(upgradeDeploymentProfileCatalogRefs(upgraded)).toEqual(upgraded)
  })
})

describe("export / import round-trip", () => {
  it("round-trips a derived set unchanged", () => {
    const derived = deriveProfiles(fixtureInput())
    const exported = exportProfilesRedacted(derived, 7)
    const reimported = importProfiles(JSON.parse(JSON.stringify(exported)))
    expect(reimported.ok).toBe(true)
    if (reimported.ok) {
      expect(reimported.value).toEqual(exported)
      expect(reimported.value.profileVersion).toBe(7)
    }
  })

  it("refuses inline secrets and newer schema versions", () => {
    const derived = deriveProfiles(fixtureInput())
    const exported = exportProfilesRedacted(derived, 1)

    const withSecret = JSON.parse(JSON.stringify(exported))
    withSecret.deploymentProfiles[0].apiKey = "sk-live-nope"
    const rejectedSecret = importProfiles(withSecret)
    expect(rejectedSecret.ok).toBe(false)

    const newer = { ...exported, schemaVersion: 999 }
    const rejectedNewer = importProfiles(newer)
    expect(rejectedNewer.ok).toBe(false)
    if (!rejectedNewer.ok) {
      expect(rejectedNewer.errors.join(" ")).toContain("newer than supported")
    }
  })

  it("labels per-document validation failures with their index", () => {
    const derived = deriveProfiles(fixtureInput())
    const exported = JSON.parse(JSON.stringify(exportProfilesRedacted(derived, 1)))
    exported.deploymentProfiles[0].endpoint = ""
    exported.legacyAliases = { a: 1 }
    const result = importProfiles(exported)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join("\n")).toMatch(/deploymentProfiles\[0\]/)
      expect(result.errors.join("\n")).toContain("legacyAliases")
    }
  })

  it("rejects non-object payloads", () => {
    expect(importProfiles(null).ok).toBe(false)
    expect(importProfiles([]).ok).toBe(false)
    expect(importProfiles("{}").ok).toBe(false)
  })
})
