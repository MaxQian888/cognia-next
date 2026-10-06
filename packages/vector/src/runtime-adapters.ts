import type { BedrockConnectionSettings } from "@cognia/provider-types"
import type { EmbeddingConfig } from "@cognia/provider-embedding/embedding"

/** Capabilities supplied by an application host; package code owns no host imports. */
export interface VectorRuntimeAdapters {
  isTauri(): boolean
  createBedrockEmbeddingModel(config: {
    modelId: string
    bedrock: BedrockConnectionSettings
  }):
    | NonNullable<EmbeddingConfig["bedrockModel"]>
    | Promise<NonNullable<EmbeddingConfig["bedrockModel"]>>
  dispatchDocumentsIndexed(collection: string, count: number): void | Promise<void>
  dispatchVectorSearch(collection: string, query: string, count: number): void | Promise<void>
}

let adapters: VectorRuntimeAdapters | undefined

export function setVectorRuntimeAdapters(next: VectorRuntimeAdapters): void {
  adapters = next
}

export function getVectorRuntimeAdapters(): VectorRuntimeAdapters {
  if (!adapters) {
    throw new Error("Vector runtime adapters have not been installed by the application host")
  }
  return adapters
}

export function resetVectorRuntimeAdaptersForTesting(): void {
  adapters = undefined
}

export function isTauri(): boolean {
  // Capability queries also run during static rendering, before a host exists.
  // Keep the intrinsic Tauri marker probe live; execution still requires adapters.
  return adapters
    ? adapters.isTauri()
    : typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}
