import { readFile } from "node:fs/promises"

import { getBuiltInProviderCatalog } from "@cognia/provider-types"

import {
  BUNDLED_CERTIFIED_PROVIDER_IDS,
  CERTIFICATION_CANDIDATES,
  getBundledCatalogRepository,
} from "./catalog-baseline"
import { resolveModelsDevProviderId } from "./models-dev-id-map"

describe("bundled catalog baseline", () => {
  it("keeps every built-in default model resolvable through an active offering", () => {
    const repository = getBundledCatalogRepository()

    for (const provider of getBuiltInProviderCatalog()) {
      const owner = provider.relayOf ?? provider.id
      const offering = repository.resolveOffering(owner, provider.defaultModel)
      expect(offering).toMatchObject({
        upstreamId: provider.defaultModel,
        lifecycle: "active",
        available: true,
      })
    }
  })

  it("keeps certification candidates separate from providers that passed conformance", () => {
    expect(CERTIFICATION_CANDIDATES.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([
        "openai",
        "vercel-ai-gateway",
        "google-vertex-ai",
        "alibaba-qwen-bailian",
        "zhipu-glm-zai",
        "volcengine-doubao",
        "vllm",
      ])
    )
    expect(BUNDLED_CERTIFIED_PROVIDER_IDS.has("openai")).toBe(true)
    expect(BUNDLED_CERTIFIED_PROVIDER_IDS.has("vercel-ai-gateway")).toBe(false)
  })

  it("keeps every mapped non-local default present in the reviewed upstream revision", async () => {
    const manifest = JSON.parse(
      await readFile("public/catalog/models-dev/manifest.json", "utf8")
    ) as { providers: Array<{ id: string; path: string }> }
    const paths = new Map(manifest.providers.map((provider) => [provider.id, provider.path]))

    for (const provider of getBuiltInProviderCatalog()) {
      if (provider.adapter === "local-openai-compatible") continue
      const upstreamId = resolveModelsDevProviderId(provider.id)
      const shardPath = upstreamId ? paths.get(upstreamId) : undefined
      if (!upstreamId || !shardPath) continue
      const shard = JSON.parse(
        await readFile(`public/catalog/models-dev/${shardPath}`, "utf8")
      ) as Record<string, { models: Record<string, unknown> }>

      expect(
        Object.prototype.hasOwnProperty.call(shard[upstreamId]?.models ?? {}, provider.defaultModel)
      ).toBe(true)
    }
  })
})
