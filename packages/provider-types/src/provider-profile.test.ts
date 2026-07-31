import {
  findSecretMaterialPaths,
  parseDeploymentProfile,
  parseProfileStoreMeta,
  parseProviderProfile,
  parseTransportProfile,
  PROFILE_STORE_SCHEMA_VERSION,
  type DeploymentProfile,
  type TransportProfile,
} from "./provider-profile"

const transport: TransportProfile = {
  id: "tp-anthropic-x-api-key",
  protocol: "anthropic",
  auth: { scheme: "x-api-key" },
  staticHeaders: { "anthropic-beta": "prompt-caching-2024-07-31" },
  forwardedSemanticHeaders: ["anthropic-beta"],
}

const deployment: DeploymentProfile = {
  id: "glm-anthropic",
  providerRef: "zhipu",
  endpoint: "https://open.bigmodel.cn/api/anthropic",
  transportProfileRef: "tp-anthropic-x-api-key",
  credentialProfileRef: { kind: "legacy-provider-settings", providerId: "glm-anthropic" },
  models: [
    {
      id: "glm-4.6",
      upstreamId: "glm-4.6",
      offeringRef: "glm-anthropic:glm-4.6",
      canonicalModelRef: "zhipu:glm-4.6",
    },
  ],
  modelRoles: { primary: "glm-4.6" },
  legacyProviderId: "glm-anthropic",
}

describe("parse round-trips", () => {
  it("accepts valid provider/deployment/transport documents", () => {
    expect(
      parseProviderProfile({ id: "zhipu", displayName: "Zhipu", deploymentRefs: ["glm-anthropic"] })
        .ok
    ).toBe(true)
    expect(parseDeploymentProfile(deployment).ok).toBe(true)
    expect(parseTransportProfile(transport).ok).toBe(true)
  })

  it("accepts v2 catalog references and bounded user overrides", () => {
    const result = parseDeploymentProfile({
      ...deployment,
      models: [
        {
          ...deployment.models[0],
          userOverride: {
            displayName: "Team GLM",
            enabled: false,
            limits: { context: 100_000 },
            capabilities: { tools: false },
          },
        },
      ],
    })

    expect(result.ok).toBe(true)
  })

  it("keeps v1 deployment models readable during migration", () => {
    expect(parseDeploymentProfile({ ...deployment, models: [{ id: "glm-4.6" }] }).ok).toBe(true)
  })

  it("accepts every credential reference kind and custom-header auth", () => {
    for (const ref of [
      { kind: "legacy-provider-settings", providerId: "openai" },
      { kind: "subscription-vault", providerId: "anthropic" },
      { kind: "secret-store", secretId: "sec-1" },
      { kind: "env", var: "MY_DEPLOYMENT_KEY" },
    ]) {
      const result = parseDeploymentProfile({ ...deployment, credentialProfileRef: ref })
      expect(result.ok).toBe(true)
    }
    expect(
      parseTransportProfile({
        ...transport,
        auth: { scheme: "custom-header", name: "x-goog-api-key" },
      }).ok
    ).toBe(true)
  })

  it("rejects malformed documents with path-labelled errors", () => {
    const missingEndpoint = parseDeploymentProfile({ ...deployment, endpoint: "" })
    expect(missingEndpoint.ok).toBe(false)
    if (!missingEndpoint.ok) {
      expect(missingEndpoint.errors.join(" ")).toContain("deploymentProfile.endpoint")
    }

    const badAuth = parseTransportProfile({ ...transport, auth: { scheme: "cookie" } })
    expect(badAuth.ok).toBe(false)

    const badRef = parseDeploymentProfile({
      ...deployment,
      credentialProfileRef: { kind: "secret-store" },
    })
    expect(badRef.ok).toBe(false)
  })
})

describe("secret hygiene", () => {
  it("rejects documents carrying secret-shaped field names at any depth", () => {
    const withKey = parseDeploymentProfile({ ...deployment, apiKey: "sk-live-123" })
    expect(withKey.ok).toBe(false)
    if (!withKey.ok) expect(withKey.errors.join(" ")).toContain('"apiKey"')

    const nested = parseTransportProfile({
      ...transport,
      staticHeaders: undefined,
      extra: { inner: { token: "abc" } },
    } as unknown)
    expect(nested.ok).toBe(false)
  })

  it("findSecretMaterialPaths reports exact paths and ignores clean docs", () => {
    expect(findSecretMaterialPaths(deployment)).toEqual([])
    expect(findSecretMaterialPaths({ a: [{ password: "x" }], b: { api_key: "y" } }).sort()).toEqual(
      ["a[0].password", "b.api_key"]
    )
  })
})

describe("parseProfileStoreMeta", () => {
  it("accepts the current schema version and refuses newer ones", () => {
    expect(
      parseProfileStoreMeta({ profileVersion: 3, schemaVersion: PROFILE_STORE_SCHEMA_VERSION }).ok
    ).toBe(true)

    const newer = parseProfileStoreMeta({
      profileVersion: 1,
      schemaVersion: PROFILE_STORE_SCHEMA_VERSION + 1,
    })
    expect(newer.ok).toBe(false)
    if (!newer.ok) expect(newer.errors.join(" ")).toContain("newer than supported")
  })

  it("rejects negative or non-integer versions", () => {
    expect(parseProfileStoreMeta({ profileVersion: -1, schemaVersion: 1 }).ok).toBe(false)
    expect(parseProfileStoreMeta({ profileVersion: 1.5, schemaVersion: 1 }).ok).toBe(false)
  })
})
