"use client"

/**
 * Vector backend settings store.
 *
 * The plugin Vector API needs to know which vector backend to use and
 * how to authenticate against it. cognia-next persists these in
 * `AppSettings` long-term, but a small in-memory cache here lets the
 * plugin runtime read them synchronously without awaiting Dexie.
 *
 * Defaults: native (sqlite-vec) backend in Tauri, openai embeddings.
 * Web mode forces a cloud backend in the Twin settings; the plugin
 * Vector API consults this store before falling back to the cloud.
 */

import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { VectorStoreProvider } from "@/lib/vector"

export interface VectorSettings {
  provider: VectorStoreProvider
  embeddingProvider: "openai" | "google" | "cohere" | "mistral"
  embeddingModel?: string

  // ChromaDB
  mode?: "embedded" | "server"
  serverUrl?: string

  // Pinecone
  pineconeApiKey?: string
  pineconeIndexName?: string
  pineconeNamespace?: string

  // Weaviate
  weaviateUrl?: string
  weaviateApiKey?: string

  // Qdrant
  qdrantUrl?: string
  qdrantApiKey?: string

  // Milvus / Zilliz
  milvusAddress?: string
  milvusToken?: string
  milvusUsername?: string
  milvusPassword?: string
  milvusSsl?: boolean
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
    { name: "cognia-vector-settings" }
  )
)
