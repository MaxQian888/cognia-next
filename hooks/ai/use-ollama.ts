"use client"

/**
 * Ollama lifecycle hook used by the legacy `OllamaModelManager`.
 *
 * All operations delegate to provider-core, which routes desktop HTTP through
 * the Rust proxy and uses the dedicated streaming transport for model pulls.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import {
  deleteOllamaModel,
  getOllamaStatus,
  listOllamaModels,
  listRunningModels,
  pullOllamaModel,
  stopOllamaModel,
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
  const pullHandles = useRef(new Map<string, () => void>())

  const refresh = useCallback(async () => {
    if (!baseUrl) return
    setIsLoading(true)
    setError(null)
    try {
      const [nextStatus, nextModels] = await Promise.all([
        getOllamaStatus(baseUrl),
        listOllamaModels(baseUrl),
      ])
      setModels(nextModels)
      setStatus({
        state: nextStatus.connected ? "connected" : "disconnected",
        version: nextStatus.version,
        models_count: nextModels.length,
      })

      try {
        setRunningModels(await listRunningModels(baseUrl))
      } catch {
        setRunningModels([])
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

  useEffect(() => {
    const handles = pullHandles.current
    return () => {
      handles.forEach((unsubscribe) => unsubscribe())
      handles.clear()
    }
  }, [])

  const pullModel = useCallback(
    async (modelName: string) => {
      if (!baseUrl) return
      setError(null)
      setPullStates((previous) => {
        const next = new Map(previous)
        next.set(modelName, {
          modelName,
          status: "pulling",
          percentage: 0,
          isActive: true,
        })
        return next
      })

      try {
        const handle = await pullOllamaModel(baseUrl, modelName, (progress) => {
          setPullStates((previous) => {
            const current = previous.get(modelName)
            if (!current?.isActive) return previous
            const next = new Map(previous)
            const percentage =
              progress.total && progress.completed
                ? Math.min(100, Math.round((progress.completed / progress.total) * 100))
                : current.percentage
            next.set(modelName, {
              ...current,
              progress,
              digest: progress.digest ?? current.digest,
              percentage,
            })
            return next
          })
        })
        pullHandles.current.set(modelName, handle.unsubscribe)
        setPullStates((previous) => {
          const current = previous.get(modelName)
          if (!current?.isActive) return previous
          const next = new Map(previous)
          next.set(modelName, {
            ...current,
            status: handle.success ? "completed" : "error",
            percentage: handle.success ? 100 : current.percentage,
            error: handle.success ? undefined : "pull-failed",
            isActive: false,
          })
          return next
        })
        handle.unsubscribe()
        pullHandles.current.delete(modelName)
        if (handle.success) await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setPullStates((previous) => {
          const next = new Map(previous)
          next.set(modelName, {
            modelName,
            status: "error",
            percentage: 0,
            error: message,
            isActive: false,
          })
          return next
        })
      }
    },
    [baseUrl, refresh]
  )

  const cancelPull = useCallback(async (modelName: string) => {
    pullHandles.current.get(modelName)?.()
    pullHandles.current.delete(modelName)
    setPullStates((previous) => {
      const current = previous.get(modelName)
      const next = new Map(previous)
      next.set(modelName, {
        modelName,
        percentage: current?.percentage ?? 0,
        ...current,
        status: "cancelled",
        isActive: false,
      })
      return next
    })
  }, [])

  const deleteModel = useCallback(
    async (modelName: string) => {
      if (!baseUrl) return
      setError(null)
      try {
        await deleteOllamaModel(baseUrl, modelName)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [baseUrl, refresh]
  )

  const stopModel = useCallback(
    async (modelName: string) => {
      if (!baseUrl) return
      setError(null)
      try {
        await stopOllamaModel(baseUrl, modelName)
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [baseUrl, refresh]
  )

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
    pullModel,
    cancelPull,
    deleteModel,
    stopModel,
  }
}
