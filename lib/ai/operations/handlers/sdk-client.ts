/**
 * The AI SDK provider client for a resolved provider, seen through the
 * optional model factories the handlers need. `createFeatureProviderClient`
 * returns a union of vendor clients whose extra factories (embedding, image,
 * speech, transcription, reranking, video) are optional per vendor, so the
 * handlers ask for each one and answer `capability-unsupported` honestly
 * when the client has none.
 */

import { createFeatureProviderClient, type ResolvedProvider } from "@/lib/ai/provider-consumption"

import { ProviderOperationFailureError } from "../failure"

export interface ProviderSdkClient {
  languageModel?(modelId: string): unknown
  embeddingModel?(modelId: string): unknown
  textEmbeddingModel?(modelId: string): unknown
  imageModel?(modelId: string): unknown
  speechModel?(modelId: string): unknown
  transcriptionModel?(modelId: string): unknown
  rerankingModel?(modelId: string): unknown
  videoModel?(modelId: string): unknown
}

export function providerSdkClient(provider: ResolvedProvider): ProviderSdkClient {
  return createFeatureProviderClient({
    providerId: provider.providerId,
    apiKey: provider.apiKey,
    baseURL: provider.baseURL,
    bedrock: provider.bedrock,
    protocol: provider.protocol,
    apiFlavor: provider.apiFlavor,
    isCustomProvider: provider.isCustomProvider,
    useProxy: provider.useProxy,
    ...(provider.headers ? { headers: provider.headers } : {}),
  }) as unknown as ProviderSdkClient
}

/** The model id a request names, else the provider's configured one. */
export function requireModelId(provider: ResolvedProvider, requested: string | undefined): string {
  const model = requested?.trim() || provider.model
  if (!model) {
    throw new ProviderOperationFailureError({
      code: "schema",
      retryable: false,
      message: `no model named for ${provider.providerId} and none configured`,
    })
  }
  return model
}

type FactoryName = Exclude<keyof ProviderSdkClient, "languageModel">

/** Resolve one optional model factory, failing typed when the vendor client lacks it. */
export function requireModelFactory<T>(
  client: ProviderSdkClient,
  provider: ResolvedProvider,
  names: readonly FactoryName[],
  what: string
): (modelId: string) => T {
  for (const name of names) {
    const factory = client[name]
    if (typeof factory === "function") return (modelId) => factory.call(client, modelId) as T
  }
  throw new ProviderOperationFailureError({
    code: "capability-unsupported",
    retryable: false,
    message: `${provider.providerId} has no ${what} model factory in its SDK client`,
  })
}
