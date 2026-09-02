import { PROVIDER_OPERATION_IDS, type ProviderOperationDescriptor } from "@cognia/provider-types"
import {
  BUILT_IN_PROVIDER_IDS,
  getBuiltInProviderCatalogEntry,
} from "@cognia/provider-types/built-in-provider-catalog"

import type { ProviderOffering } from "@cognia/provider-types/model-catalog"
import {
  OPERATION_IDS_BY_ENDPOINT_TYPE,
  OPERATION_IDS_BY_MODALITY,
  buildProviderOperationProfile,
  builtInProviderSurfaceFacts,
} from "./capability-matrix"

function cell(providerId: string, operationId: string) {
  const profile = buildProviderOperationProfile({ providerId, computedAt: 1 })
  const found = profile.cells.find((c) => c.operationId === operationId)
  if (!found) throw new Error(`${providerId} has no cell for ${operationId}`)
  return found
}

describe("capability matrix", () => {
  it("answers every built-in provider × operation without unknown, and every unsupported has a reason", () => {
    let scanned = 0
    for (const providerId of BUILT_IN_PROVIDER_IDS) {
      const profile = buildProviderOperationProfile({ providerId, computedAt: 1 })
      expect(profile.cells).toHaveLength(PROVIDER_OPERATION_IDS.length)
      for (const c of profile.cells) {
        scanned += 1
        expect(c.support).not.toBe("unknown")
        if (c.support === "unsupported") {
          expect(c.reason.length).toBeGreaterThan(0)
          expect(c.availability).toBe("unavailable")
        }
      }
    }
    expect(scanned).toBe(BUILT_IN_PROVIDER_IDS.length * PROVIDER_OPERATION_IDS.length)
  })

  it("encodes vendor facts: OpenAI is full-surface, a relay is chat-only, Voyage is retrieval-only", () => {
    expect(cell("openai", "files.upload").support).toBe("native")
    expect(cell("openai", "moderation.create").support).toBe("native")
    expect(cell("openai", "rerank.create")).toMatchObject({ support: "unsupported" })

    expect(cell("glm-anthropic", "language.generate").support).toBe("native")
    expect(cell("glm-anthropic", "tokens.count").support).toBe("derived")
    expect(cell("glm-anthropic", "files.upload")).toMatchObject({ support: "unsupported" })
    expect(cell("glm-anthropic", "quota.read").support).toBe("native")

    expect(cell("voyage", "embeddings.create").support).toBe("native")
    expect(cell("voyage", "rerank.create").support).toBe("native")
    expect(cell("voyage", "language.generate")).toMatchObject({ support: "unsupported" })

    expect(cell("anthropic", "tokens.count").support).toBe("native")
    expect(cell("anthropic", "language.structured-output").support).toBe("translated")
    expect(cell("deepseek", "balance.read").support).toBe("native")
    expect(cell("ollama", "usage.local.read").support).toBe("derived")
  })

  it("lets an available catalog offering widen the static facts", () => {
    const catalog = {
      listOfferings: (): ProviderOffering[] => [
        {
          id: "cerebras:embed",
          providerRef: "cerebras",
          modelRef: "cerebras:embed",
          upstreamId: "embed",
          endpointType: "embedding",
          lifecycle: "active",
          available: true,
          source: { kind: "official", id: "test" },
        },
      ],
    }
    expect(cell("cerebras", "embeddings.create")).toMatchObject({ support: "unsupported" })
    const widened = buildProviderOperationProfile({
      providerId: "cerebras",
      catalog,
      computedAt: 1,
    })
    expect(widened.cells.find((c) => c.operationId === "embeddings.create")?.support).toBe("native")
  })

  it("plugin cells override the static answer", () => {
    const profile = buildProviderOperationProfile({
      providerId: "deepseek",
      computedAt: 1,
      pluginCells: [
        {
          operationId: "images.generate",
          support: "plugin",
          via: "acme:images",
          availability: "ready",
        },
      ],
    })
    expect(profile.cells.find((c) => c.operationId === "images.generate")).toMatchObject({
      support: "plugin",
      via: "acme:images",
    })
  })

  it("threads guard, checklist and host surfaces into availability", () => {
    const descriptors = [
      { id: "language.generate", surfaces: ["sidecar"] },
      { id: "models.list", surfaces: ["renderer", "sidecar"] },
    ] as unknown as ProviderOperationDescriptor[]
    const profile = buildProviderOperationProfile({
      providerId: "openai",
      computedAt: 1,
      guard: { allowed: false, code: "missing_credential", reason: "add a key" },
      descriptors,
      hostSurfaces: ["renderer"],
    })
    expect(profile.cells.find((c) => c.operationId === "language.generate")).toMatchObject({
      availability: "needs-host",
    })
    expect(profile.cells.find((c) => c.operationId === "models.list")).toMatchObject({
      availability: "needs-auth",
      note: "add a key",
    })
  })

  it("marks a custom deployment's vendor-dependent surfaces unknown with evidence, and protocol surfaces by protocol", () => {
    const profile = buildProviderOperationProfile({ providerId: "my-gateway", computedAt: 1 })
    const files = profile.cells.find((c) => c.operationId === "files.upload")
    expect(files).toMatchObject({
      support: "unknown",
      provenance: "custom-deployment",
      freshness: "static",
      retry: { on: "manual" },
    })
    expect(files && files.support === "unknown" && files.failure.code).toBe(
      "capability-unsupported"
    )
    expect(profile.cells.find((c) => c.operationId === "language.generate")?.support).toBe("native")
    expect(profile.cells.find((c) => c.operationId === "embeddings.create")?.support).toBe("native")
    // Probe evidence resolves the unknowns.
    const probed = buildProviderOperationProfile({
      providerId: "my-gateway",
      computedAt: 1,
      probedFacts: { files: true, images: false },
      probeFreshness: "fresh",
    })
    expect(probed.cells.find((c) => c.operationId === "files.upload")?.support).toBe("native")
    expect(probed.cells.find((c) => c.operationId === "images.generate")).toMatchObject({
      support: "unsupported",
    })
  })

  it("projections cover every endpoint type and modality with operations", () => {
    for (const ids of Object.values(OPERATION_IDS_BY_ENDPOINT_TYPE))
      expect(ids.length).toBeGreaterThan(0)
    for (const ids of Object.values(OPERATION_IDS_BY_MODALITY))
      expect(ids.length).toBeGreaterThan(0)
    expect(OPERATION_IDS_BY_ENDPOINT_TYPE.messages).toContain("tokens.count")
  })

  it("exposes resolved surface facts for the UI", () => {
    const entry = getBuiltInProviderCatalogEntry("openai")!
    expect(builtInProviderSurfaceFacts(entry).vectorStores).toBe(true)
    const relay = getBuiltInProviderCatalogEntry("kimi-coding")!
    expect(builtInProviderSurfaceFacts(relay).modelsEndpoint).toBe(false)
  })
})
