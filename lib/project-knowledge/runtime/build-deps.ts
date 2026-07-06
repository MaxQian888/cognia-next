/**
 * Best-effort dependency resolver for project-scoped RAG.
 *
 * Reuses the twin runtime's vector-store + embedding config (exactly as the
 * memory subsystem does via `resolveMemoryBackend`), so a user who configured
 * Twin embeddings gets project knowledge retrieval "for free" — one infra
 * config, three collections (`cognia_twin_*`, `cognia_memory`, `cognia_project_*`).
 *
 * Returns `undefined` when no usable vector backend is configured (→ project RAG
 * is a no-op: ingest is skipped and retrieval returns nothing). Unlike memory,
 * there is NO cloud-embedding privacy gate here — project files are the user's
 * own working documents, and PII is instead handled by cloud-only redaction at
 * ingest (`lib/project-knowledge/ingest/ingest-file.ts`).
 */

import type { IVectorStore } from "@cognia/vector/store"
import type { EmbeddingConfig } from "@/lib/twin/ingest/embed"
import type { VectorBackend } from "@/types/twin"
import { tryBuildTwinDeps } from "@/lib/twin/runtime/build-deps"

/** The (non-undefined) shape returned by `tryBuildTwinDeps`. */
type PrebuiltTwinDeps = NonNullable<Awaited<ReturnType<typeof tryBuildTwinDeps>>>

export interface ProjectKnowledgeDeps {
  /** Full vector store client (ingest needs addDocuments/createCollection/…). */
  store: IVectorStore
  /** Embedding config for ingest-time embedding. */
  embedding: EmbeddingConfig
  vectorBackend: VectorBackend
  /** Retrieval extras, reused from the twin runtime settings. */
  reranker?: PrebuiltTwinDeps["reranker"]
  expansion?: PrebuiltTwinDeps["expansion"]
}

/**
 * Build the project-knowledge deps. Pass `prebuiltTwinDeps` (e.g. the deps a
 * chat turn already built) to skip a second `tryBuildTwinDeps()` call.
 */
export async function tryBuildProjectKnowledgeDeps(
  prebuiltTwinDeps?: PrebuiltTwinDeps
): Promise<ProjectKnowledgeDeps | undefined> {
  try {
    const twinDeps = prebuiltTwinDeps ?? (await tryBuildTwinDeps())
    if (!twinDeps) return undefined
    // The runtime object from `createVectorStore` is a full `IVectorStore`; the
    // twin deps type narrows it to `searchByEmbedding` only. Recover the full
    // interface for the ingest path (addDocuments / createCollection / …).
    const store = twinDeps.store as unknown as IVectorStore
    if (typeof store?.addDocuments !== "function") return undefined
    const emb = twinDeps.embedding
    return {
      store,
      embedding: {
        provider: emb.provider as EmbeddingConfig["provider"],
        model: emb.model,
        apiKey: emb.apiKey,
        baseURL: emb.baseURL,
      },
      vectorBackend: twinDeps.vectorBackend ?? (store.provider as VectorBackend),
      reranker: twinDeps.reranker,
      expansion: twinDeps.expansion,
    }
  } catch {
    return undefined
  }
}
