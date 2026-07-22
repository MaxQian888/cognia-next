"use client"

/**
 * Vector backend settings store.
 *
 * Per-provider credentials (API keys, URLs, tokens) moved to the OS
 * keyring via the Rust side after ADR-0022 — this store now only holds
 * the provider selection, embedding config, and per-provider `configId`
 * pointers. The actual secrets are addressed by `configId` and resolved
 * server-side. See lib/vector/migrations/credential-migration.ts for the
 * one-shot upgrade path from the pre-ADR-0022 cleartext layout.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import { persistLocalStorage } from "@/stores/persist-storage"
import type { VectorStoreProvider } from "@cognia/vector"
import type { RagEmbeddingProvider } from "@cognia/provider-embedding/embedding-catalog"

export interface VectorSettings {
  provider: VectorStoreProvider
  embeddingProvider: RagEmbeddingProvider
  embeddingModel?: string

  // ADR-0022: per-provider config_id pointers into the OS keyring.
  // The actual secrets (api_key, url, token, …) are NOT persisted here.
  pineconeConfigId?: string
  qdrantConfigId?: string
  chromaConfigId?: string
  milvusConfigId?: string
  weaviateConfigId?: string
}

export interface VectorStoreState {
  settings: VectorSettings
  setSettings: (patch: Partial<VectorSettings>) => void
  reset: () => void
}

const DEFAULTS: VectorSettings = {
  provider: "native",
  embeddingProvider: "openai",
}

export const useVectorStore = create<VectorStoreState>()(
  persist(
    (set) => ({
      settings: { ...DEFAULTS },
      setSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
      reset: () => set({ settings: { ...DEFAULTS } }),
    }),
    {
      name: "cognia-vector-settings",
      storage: persistLocalStorage(),
      // Bump on every credential-layout migration so the one-shot
      // credential-migration script can detect pre-ADR-0022 state and
      // run exactly once.
      version: 2,
    }
  )
)
