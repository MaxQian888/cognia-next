"use client"

/**
 * useLocalProvider — Cognia-compatible local-provider hook.
 *
 * Wraps `lib/ai/providers/local-provider-service` and exposes the same
 * shape Cognia's UI components consume (status, models, pullStates,
 * destructive ops). cognia-next deferred the Tauri commands that drive
 * pull/delete/stop, so the destructive ops surface a "deferred" error
 * rather than performing the work.
 */

import { useCallback, useEffect, useState } from "react"
import type {
  LocalProviderName,
  LocalServerStatus,
  LocalModelInfo,
  LocalModelPullProgress,
} from "@/types/provider/local-provider"
import {
  createLocalProviderService,
  getProviderCapabilities,
  type LocalProviderCapabilities,
} from "@/lib/ai/providers/local-provider-service"
import { LOCAL_PROVIDER_CONFIGS } from "@/lib/ai/providers/local-providers"

export interface LocalPullState {
  status: "pulling" | "completed" | "error" | "cancelled"
  modelName: string
  /** Latest pull-progress event from the server (Cognia shape). */
  progress?: LocalModelPullProgress
  /** Convenience scalar 0–100. */
  percentage: number
  digest?: string
  error?: string
  /** Cognia's flag — true while a pull is in flight. */
  isActive: boolean
}

export interface UseLocalProviderArgs {
  providerId: LocalProviderName
  baseUrl?: string
  autoRefresh?: boolean
  refreshInterval?: number
}

export interface UseLocalProviderResult {
  config: (typeof LOCAL_PROVIDER_CONFIGS)[string] | undefined
  capabilities: LocalProviderCapabilities
  status: LocalServerStatus | null
  isConnected: boolean
  isLoading: boolean
  error: string | null
  models: LocalModelInfo[]
  runningModels: LocalModelInfo[]
  pullStates: Map<string, LocalPullState>
  isPulling: boolean
  refresh: () => Promise<void>
  testServer: () => Promise<LocalServerStatus | null>
  fetchModels: () => Promise<LocalModelInfo[]>
  pullModel: (modelName: string) => Promise<void>
  cancelPull: (modelName: string) => Promise<void>
  deleteModel: (modelName: string) => Promise<void>
  stopModel: (modelName: string) => Promise<void>
}

export function useLocalProvider(args: UseLocalProviderArgs): UseLocalProviderResult {
  const { providerId, baseUrl, autoRefresh, refreshInterval = 30_000 } = args

  const config = LOCAL_PROVIDER_CONFIGS[providerId]
  const capabilities = getProviderCapabilities(providerId)

  const [status, setStatus] = useState<LocalServerStatus | null>(null)
  const [models, setModels] = useState<LocalModelInfo[]>([])
  const [runningModels, _setRunningModels] = useState<LocalModelInfo[]>([])
  const [pullStates, setPullStates] = useState<Map<string, LocalPullState>>(() => new Map())
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!baseUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const service = createLocalProviderService(providerId, baseUrl)
      const [s, m] = await Promise.all([service.getStatus(), service.listModels()])
      setStatus(s)
      setModels(m)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setIsLoading(false)
    }
  }, [providerId, baseUrl])

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

  const testServer = useCallback(async () => {
    if (!baseUrl) return null
    setIsLoading(true)
    setError(null)
    try {
      const service = createLocalProviderService(providerId, baseUrl)
      const s = await service.getStatus()
      setStatus(s)
      return s
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setIsLoading(false)
    }
  }, [providerId, baseUrl])

  const fetchModels = useCallback(async () => {
    if (!baseUrl) return []
    setIsLoading(true)
    setError(null)
    try {
      const service = createLocalProviderService(providerId, baseUrl)
      const m = await service.listModels()
      setModels(m)
      return m
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return []
    } finally {
      setIsLoading(false)
    }
  }, [providerId, baseUrl])

  const deferred = useCallback(async (op: string, modelName: string) => {
    setError(`${op} for "${modelName}" requires native bindings (deferred).`)
    setPullStates((prev) => {
      const next = new Map(prev)
      next.set(modelName, {
        modelName,
        status: "error",
        percentage: 0,
        error: "Native bindings deferred",
        isActive: false,
      })
      return next
    })
  }, [])

  return {
    config,
    capabilities,
    status,
    isConnected: status?.connected ?? false,
    isLoading,
    error,
    models,
    runningModels,
    pullStates,
    isPulling: Array.from(pullStates.values()).some((p) => p.isActive),
    refresh,
    testServer,
    fetchModels,
    pullModel: async (m) => deferred("Model pull", m),
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
    deleteModel: async (m) => deferred("Model delete", m),
    stopModel: async (m) => deferred("Model stop", m),
  }
}

/** Stub for `useLocalProvidersScan` — Cognia's multi-provider auto-detect. */
export function useLocalProvidersScan() {
  return {
    detected: new Map<LocalProviderName, LocalServerStatus>(),
    /** Cognia's components also read this Map under the `results` alias. */
    results: new Map<LocalProviderName, LocalServerStatus>(),
    isScanning: false,
    error: null as string | null,
    scan: async () => undefined,
  }
}
