"use client"

/**
 * Minimal Ollama hook used by `ollama-model-manager.tsx`.
 *
 * Cognia ships a richer hook that talks to native Ollama Tauri commands
 * (model pull / cancel / delete). cognia-next defers those Rust bindings;
 * this hook lists models via the public REST API and reports "not
 * available" for the destructive operations until the Rust side ships.
 */

import { useCallback, useEffect, useState } from "react"
import {
  generateOllamaEmbedding as _ignored,
  // The HTTP helpers live in the same module as the embedding helper; we
  // just need direct fetch against /api/tags etc. so this is intentional.
} from "@cognia/provider-core/providers/ollama"

export interface OllamaModel {
  name: string
  model?: string
  size?: number
  digest?: string
  modified_at?: string
}

import type { OllamaPullProgress } from "@cognia/provider-types/ollama"

export interface OllamaPullState {
  status: "pulling" | "completed" | "error" | "cancelled"
  modelName: string
  /** Latest pull-progress event (Cognia shape). */
  progress?: OllamaPullProgress
  percentage: number
  digest?: string
  error?: string
  isActive: boolean
}

export interface UseOllamaArgs {
  baseUrl: string
  autoRefresh?: boolean
  refreshInterval?: number
}

export interface OllamaStatus {
  state: "connected" | "disconnected" | "unknown" | "error"
  version?: string
  models_count?: number
  latency_ms?: number
}

export interface UseOllamaResult {
  status: OllamaStatus | null
  isConnected: boolean
  isLoading: boolean
  error: string | null
  models: OllamaModel[]
  runningModels: OllamaModel[]
  pullStates: Map<string, OllamaPullState>
  isPulling: boolean
  refresh: () => Promise<void>
  pullModel: (modelName: string) => Promise<void>
  cancelPull: (modelName: string) => Promise<void>
  deleteModel: (modelName: string) => Promise<void>
  stopModel: (modelName: string) => Promise<void>
}

export function useOllama(args: UseOllamaArgs): UseOllamaResult {
  const { baseUrl, autoRefresh, refreshInterval = 30_000 } = args
  const [status, setStatus] = useState<OllamaStatus | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [models, setModels] = useState<OllamaModel[]>([])
  const [runningModels, setRunningModels] = useState<OllamaModel[]>([])
  const [pullStates, setPullStates] = useState<Map<string, OllamaPullState>>(() => new Map())

  const refresh = useCallback(async () => {
    if (!baseUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
        method: "GET",
      })
      if (!res.ok) throw new Error(`Ollama responded ${res.status}`)
      const data = (await res.json()) as { models?: OllamaModel[] }
      setModels(data.models ?? [])

      // Best-effort version query.
      let version: string | undefined
      try {
        const verRes = await fetch(`${baseUrl.replace(/\/$/, "")}/api/version`)
        if (verRes.ok) {
          const verData = (await verRes.json()) as { version?: string }
          version = verData.version
        }
      } catch {
        // optional
      }

      setStatus({
        state: "connected",
        version,
        models_count: data.models?.length ?? 0,
      })

      // Best-effort running-models query
      try {
        const psRes = await fetch(`${baseUrl.replace(/\/$/, "")}/api/ps`, {
          method: "GET",
        })
        if (psRes.ok) {
          const psData = (await psRes.json()) as { models?: OllamaModel[] }
          setRunningModels(psData.models ?? [])
        }
      } catch {
        // /api/ps is optional on older Ollama versions; ignore.
      }
    } catch (err) {
      setStatus({ state: "error" })
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [baseUrl])

  useEffect(() => {
    const initial = setTimeout(() => void refresh(), 0)
    if (!autoRefresh) {
      return () => clearTimeout(initial)
    }
    const id = setInterval(() => void refresh(), refreshInterval)
    return () => {
      clearTimeout(initial)
      clearInterval(id)
    }
  }, [refresh, autoRefresh, refreshInterval])

  const unavailable = useCallback(async (op: string, modelName: string) => {
    setError(`${op} for "${modelName}" requires native Ollama bindings (deferred).`)
  }, [])

  return {
    status,
    isConnected: status?.state === "connected",
    isLoading,
    error,
    models,
    runningModels,
    pullStates,
    isPulling: Array.from(pullStates.values()).some((p) => p.isActive),
    refresh,
    pullModel: async (m) => {
      setPullStates((prev) => {
        const next = new Map(prev)
        next.set(m, {
          modelName: m,
          status: "error",
          percentage: 0,
          error: "Native pull deferred",
          isActive: false,
        })
        return next
      })
      await unavailable("pullModel", m)
    },
    cancelPull: async (m) => {
      setPullStates((prev) => {
        const next = new Map(prev)
        const cur = next.get(m) ?? {
          modelName: m,
          percentage: 0,
          status: "cancelled" as const,
          isActive: false,
        }
        next.set(m, { ...cur, status: "cancelled", isActive: false })
        return next
      })
    },
    deleteModel: async (m) => unavailable("deleteModel", m),
    stopModel: async (m) => unavailable("stopModel", m),
  }
}
