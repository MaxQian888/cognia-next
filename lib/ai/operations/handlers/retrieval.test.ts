/** @jest-environment node */
jest.mock("./ai-sdk-surface", () => ({ embedManyGated: jest.fn(), rerankGated: jest.fn() }))
const surface = jest.requireMock("./ai-sdk-surface") as {
  embedManyGated: jest.Mock
  rerankGated: jest.Mock
}
jest.mock("./http", () => ({ providerRequest: jest.fn() }))
const http = jest.requireMock("./http") as { providerRequest: jest.Mock }
const client: Record<string, unknown> = {}
jest.mock("@/lib/ai/provider-consumption", () => ({ createFeatureProviderClient: () => client }))

import type { ResolvedProvider } from "@/lib/ai/provider-consumption"

import { getProviderOperationDescriptor } from "../manifest"
import { embeddingsCreateHandler, rerankCreateHandler } from "./retrieval"

const provider: ResolvedProvider = {
  kind: "resolved",
  providerId: "openai",
  protocol: "openai",
  apiKey: "k",
  baseURL: "https://a/v1",
  model: "configured",
  isCustomProvider: false,
  useProxy: false,
}
const settings = { defaultProvider: "openai", providers: {}, customProviders: [] }

describe("retrieval handlers", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    for (const key of Object.keys(client)) delete client[key]
  })

  it("embeds through the client's embedding factory and copies the vectors out", async () => {
    client.embeddingModel = (id: string) => ({ id })
    surface.embedManyGated.mockResolvedValueOnce({ embeddings: [[1, 2]], usage: { tokens: 4 } })
    const output = await embeddingsCreateHandler.handler({
      descriptor: getProviderOperationDescriptor("embeddings.create")!,
      provider,
      settings,
      request: {
        operationId: "embeddings.create",
        scopes: ["provider:invoke"],
        surface: "sidecar",
        input: { model: "e", values: ["x"] },
      },
    })
    expect(surface.embedManyGated).toHaveBeenCalledWith(
      expect.objectContaining({ model: { id: "e" }, values: ["x"] })
    )
    expect(output).toEqual({ embeddings: [[1, 2]], usage: { tokens: 4 } })
  })

  it("reranks through the SDK model when the client has one, else over the rerank wire", async () => {
    const request = {
      operationId: "rerank.create" as const,
      scopes: ["provider:invoke" as const],
      surface: "sidecar" as const,
      input: { model: "r", query: "q", documents: ["a", "b"], topN: 1 },
    }
    const base = {
      descriptor: getProviderOperationDescriptor("rerank.create")!,
      provider,
      settings,
      request,
    }
    client.rerankingModel = (id: string) => ({ id })
    surface.rerankGated.mockResolvedValueOnce({
      ranking: [{ originalIndex: 1, score: 0.9, document: "b" }],
    })
    await expect(rerankCreateHandler.handler(base)).resolves.toEqual({
      ranking: [{ index: 1, score: 0.9 }],
    })
    expect(http.providerRequest).not.toHaveBeenCalled()

    delete client.rerankingModel
    http.providerRequest.mockResolvedValueOnce({
      json: { results: [{ index: 0, relevance_score: 0.4 }] },
    })
    await expect(rerankCreateHandler.handler(base)).resolves.toEqual({
      ranking: [{ index: 0, score: 0.4 }],
    })
    expect(http.providerRequest).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({
        path: "rerank",
        body: { model: "r", query: "q", documents: ["a", "b"], top_n: 1 },
      })
    )
  })
})
