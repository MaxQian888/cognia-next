// Embedding-provider registry (§E new module).
//
// Plugins declaring the `ai-provider` capability can contribute embedding
// providers (OpenAI, Voyage, Jina, Cohere, …). cognia-next ships a single
// throwing stub at `lib/ai/providers/ollama.ts` today; this registry adds
// a programmatic registration surface that the plugin manager writes into.
//
// The registry is consumed by `lib/ai/embedding/embedding.ts` (post-Phase-2)
// when resolving an embedding model. Until that consumer wires in, the
// registry is harmless: empty by default, no behavior change for existing
// callers.

export interface EmbeddingProvider {
  /** Stable id (typically `${pluginId}.${providerName}`). */
  id: string
  /** User-facing name. */
  name: string
  /** Optional description. */
  description?: string
  /** Free-form list of embedding model ids the provider supports. */
  modelIds?: string[]
  /**
   * Generate an embedding for the supplied text. Implementations may
   * dispatch to a remote API or a local runtime. Throws when the model id
   * is unknown to the provider.
   */
  generateEmbedding(text: string, options?: { modelId?: string }): Promise<number[]>
  /** Origin tag — set by the plugin manager. */
  source?: "builtin" | "plugin"
  pluginId?: string
}

const registry = new Map<string, EmbeddingProvider>()

export function registerEmbeddingProvider(provider: EmbeddingProvider): { replaced: boolean } {
  if (!provider.id) throw new Error("registerEmbeddingProvider: id is required")
  if (typeof provider.generateEmbedding !== "function") {
    throw new Error(
      `registerEmbeddingProvider: provider "${provider.id}" must define generateEmbedding`
    )
  }
  const replaced = registry.has(provider.id)
  registry.set(provider.id, provider)
  return { replaced }
}

export function unregisterEmbeddingProvider(id: string): boolean {
  return registry.delete(id)
}

export function unregisterProvidersByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, provider] of registry) {
    if (provider.pluginId === pluginId) {
      registry.delete(id)
      removed += 1
    }
  }
  return removed
}

export function getEmbeddingProvider(id: string): EmbeddingProvider | undefined {
  return registry.get(id)
}

export function listEmbeddingProviders(): EmbeddingProvider[] {
  return Array.from(registry.values())
}

/** Test-only escape hatch. */
export function __resetEmbeddingProvidersForTesting(): void {
  registry.clear()
}
