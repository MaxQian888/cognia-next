import { readFile } from "node:fs/promises"

import { getBuiltInProviderCatalog } from "@cognia/provider-types"
import {
  isModelLifecycleAllowed,
  resolveModelLifecycle,
} from "@cognia/provider-types/model-catalog"

import {
  BUNDLED_CERTIFIED_PROVIDER_IDS,
  CERTIFICATION_CANDIDATES,
  getBundledCatalogRepository,
} from "./catalog-baseline"
import { resolveModelsDevProviderId } from "./models-dev-id-map"
import type { ModelsDevApi } from "./models-dev"

let reviewed: ModelsDevApi

beforeAll(async () => {
  const manifest = JSON.parse(
    await readFile("public/catalog/models-dev/manifest.json", "utf8")
  ) as {
    providers: Array<{ id: string; path: string }>
  }
  reviewed = Object.assign(
    {},
    ...(await Promise.all(
      manifest.providers.map(async (provider) =>
        JSON.parse(await readFile(`public/catalog/models-dev/${provider.path}`, "utf8"))
      )
    ))
  ) as ModelsDevApi
})

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

  it("checks every mapped non-local default against its model catalog or reviewed preset contract", () => {
    for (const provider of getBuiltInProviderCatalog()) {
      if (provider.type === "local") continue
      const upstreamId = resolveModelsDevProviderId(provider.id)
      if (!upstreamId) continue
      expect({ provider: provider.id, tracked: Boolean(reviewed[upstreamId]) }).toEqual({
        provider: provider.id,
        tracked: true,
      })
      if (provider.id === "perplexity") {
        // Agent API presets select a server-managed configuration, not a
        // models.dev model ID. Its exact request contract is SDK-tested in
        // perplexity-agent.test.ts and documented by Perplexity's migration guide.
        expect(provider.defaultModel).toBe("preset/fast")
      } else {
        expect({
          provider: provider.id,
          default: provider.defaultModel,
          present: Object.hasOwn(reviewed[upstreamId].models, provider.defaultModel),
        }).toEqual({ provider: provider.id, default: provider.defaultModel, present: true })
      }
      if (provider.models) {
        expect({
          provider: provider.id,
          listed: provider.models.some((model) => model.id === provider.defaultModel),
        }).toEqual({ provider: provider.id, listed: true })
      }
    }
  })

  it("maps every cloud built-in that the reviewed baseline tracks directly", () => {
    const unmapped = getBuiltInProviderCatalog()
      .filter((provider) => provider.type === "cloud" && reviewed[provider.id])
      .filter((provider) => !resolveModelsDevProviderId(provider.id))
      .map((provider) => provider.id)
    expect(unmapped).toEqual([])
  })

  it("keeps recommended default capabilities and limits aligned with the reviewed baseline", () => {
    const mismatches: string[] = []
    for (const provider of getBuiltInProviderCatalog()) {
      if (provider.type === "local") continue
      const remoteId = resolveModelsDevProviderId(provider.id)
      const remote = remoteId && reviewed[remoteId]?.models[provider.defaultModel]
      if (!remote) continue
      const model = provider.models?.find((candidate) => candidate.id === provider.defaultModel)
      const fields = {
        contextLength: remote.limit?.context,
        maxOutputTokens: remote.limit?.output,
        supportsVision: remote.modalities?.input?.includes("image"),
        supportsTools: remote.tool_call,
        supportsReasoning: remote.reasoning,
        supportsTemperature: remote.temperature,
      }
      for (const [field, expected] of Object.entries(fields)) {
        const actual = model?.[field as keyof NonNullable<typeof model>]
        if (expected !== undefined && actual !== undefined && actual !== expected) {
          mismatches.push(
            `${provider.id}/${provider.defaultModel}.${field}: ${actual} != ${expected}`
          )
        }
      }
      if (remote.temperature === false && model?.supportsTemperature !== false) {
        mismatches.push(`${provider.id}/${provider.defaultModel} must disable unsupported sampling`)
      }
      if (
        !isModelLifecycleAllowed(
          resolveModelLifecycle(provider.id, provider.defaultModel, remote.status).lifecycle,
          "auto"
        )
      ) {
        mismatches.push(`${provider.id}/${provider.defaultModel} is not an active recommendation`)
      }
    }
    expect(mismatches).toEqual([])
  })

  it("does not recommend coding IDs removed from a tracked provider", () => {
    const missing: string[] = []
    for (const provider of getBuiltInProviderCatalog()) {
      const remoteId = resolveModelsDevProviderId(provider.id)
      if (!remoteId || !reviewed[remoteId]) continue
      for (const model of provider.models ?? []) {
        if (model.recommendedFor?.includes("coding") && !reviewed[remoteId].models[model.id]) {
          missing.push(`${provider.id}/${model.id}`)
        }
      }
    }
    expect(missing).toEqual([])
  })

  it("checks coding packages against their subscription catalog rather than pay-as-you-go", () => {
    const planCatalogs: Record<string, string> = {
      zhipu: "zhipuai-coding-plan",
      minimax: "minimax-coding-plan",
    }
    const missing: string[] = []
    for (const provider of getBuiltInProviderCatalog()) {
      if (!provider.codingPackage) continue
      const plan = reviewed[planCatalogs[provider.id]]
      expect(plan).toBeDefined()
      for (const modelId of new Set([
        provider.codingPackage.defaultModel,
        ...provider.codingPackage.modelIds,
      ])) {
        if (!plan?.models[modelId]) missing.push(`${provider.id}/coding/${modelId}`)
      }
    }
    expect(missing).toEqual([])
  })
})
