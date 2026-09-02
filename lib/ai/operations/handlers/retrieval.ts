/**
 * `embeddings.create` and `rerank.create`. Embeddings always go through the
 * vendor's AI SDK embedding model. Rerank uses the SDK reranking model when
 * the vendor client has one and otherwise the `POST /rerank` wire shared by
 * the OpenAI-compatible rerank vendors (`{model, query, documents, top_n}` in,
 * `{results: [{index, relevance_score}]}` out).
 */

import type { ProviderOperationHandlerRegistration } from "../registry"
import { embedManyGated, rerankGated, type EmbedManyArgs, type RerankArgs } from "./ai-sdk-surface"
import { providerRequest } from "./http"
import { providerSdkClient, requireModelFactory, requireModelId } from "./sdk-client"

export interface EmbeddingsCreateInput {
  model?: string
  values: string[]
}

export interface EmbeddingsCreateOutput {
  embeddings: number[][]
  usage: { tokens: number }
}

export const embeddingsCreateHandler: ProviderOperationHandlerRegistration<
  EmbeddingsCreateInput,
  EmbeddingsCreateOutput
> = {
  operationId: "embeddings.create",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const client = providerSdkClient(provider)
    const make = requireModelFactory<EmbedManyArgs["model"]>(
      client,
      provider,
      ["embeddingModel", "textEmbeddingModel"],
      "embedding"
    )
    const result = await embedManyGated({
      model: make(requireModelId(provider, request.input.model)),
      values: request.input.values,
      ...(signal ? { abortSignal: signal } : {}),
    })
    return {
      embeddings: result.embeddings.map((embedding) => [...embedding]),
      usage: { tokens: result.usage?.tokens ?? 0 },
    }
  },
}

export interface RerankCreateInput {
  model?: string
  query: string
  documents: string[]
  topN?: number
}

export interface RerankCreateOutput {
  ranking: Array<{ index: number; score: number }>
}

interface RerankWire {
  results?: Array<{ index: number; relevance_score?: number; score?: number }>
}

export const rerankCreateHandler: ProviderOperationHandlerRegistration<
  RerankCreateInput,
  RerankCreateOutput
> = {
  operationId: "rerank.create",
  providerMatch: { kind: "any" },
  support: "native",
  async handler({ provider, request, signal }) {
    const model = requireModelId(provider, request.input.model)
    const client = providerSdkClient(provider)
    if (typeof client.rerankingModel === "function") {
      const result = await rerankGated({
        model: client.rerankingModel(model) as RerankArgs["model"],
        query: request.input.query,
        documents: request.input.documents,
        ...(request.input.topN !== undefined ? { topN: request.input.topN } : {}),
        ...(signal ? { abortSignal: signal } : {}),
      })
      return {
        ranking: result.ranking.map((row) => ({ index: row.originalIndex, score: row.score })),
      }
    }
    const { json } = await providerRequest<RerankWire>(provider, {
      path: "rerank",
      body: {
        model,
        query: request.input.query,
        documents: request.input.documents,
        ...(request.input.topN !== undefined ? { top_n: request.input.topN } : {}),
      },
      signal,
    })
    return {
      ranking: (json.results ?? []).map((row) => ({
        index: row.index,
        score: row.relevance_score ?? row.score ?? 0,
      })),
    }
  },
}

export const RETRIEVAL_HANDLERS = [embeddingsCreateHandler, rerankCreateHandler]
