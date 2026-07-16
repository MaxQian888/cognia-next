"use client"

/**
 * useLocalProvider — Cognia-compatible local-provider hook.
 *
 * Wraps `@cognia/provider-core/providers/local-provider-service` and exposes
 * the shape Cognia's UI components consume (status, models, pullStates,
 * destructive ops).
 *
 * The destructive ops used to be `deferred()` no-ops that only called
 * `setError("… requires native bindings")`, on the theory that pull/delete/stop
 * needed Tauri commands nobody had written. That theory was wrong twice over:
 * `LocalProviderService` already implemented all three over HTTP, and the Tauri
 * commands they were supposedly waiting on were never going to exist — the
 * whole surface reaches Ollama through the Rust HTTP proxy instead. So these
 * now call the service that was sitting there the entire time.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import type {
  LocalProviderName,
  LocalServerStatus,
  LocalModelInfo,
  LocalModelPullProgress,
} from "@cognia/provider-types/local-provider"
import {
  createLocalProviderService,
  getProviderCapabilities,
  checkAllProvidersInstallation,
  type LocalProviderCapabilities,
} from "@cognia/provider-core/providers/local-provider-service"
import { LOCAL_PROVIDER_CONFIGS } from "@cognia/provider-core/providers/local-providers"

/**
 * Stable, translatable reasons an operation failed.
 *
 * Codes rather than sentences: this hook has no `t()`, and its `error` is
 * rendered verbatim by components, so an English string here would ship
 * untranslatable text to every locale. The component maps the code — the
 * convention `hooks/connectors/use-history-hydration.ts` and
 * `hooks/memory/use-external-memory.ts` already follow.
 *
 * Server/exception text is passed through as-is, which is the repo's tolerated
 * pattern; only strings WE author become codes.
 */
export type LocalProviderErrorCode = "pull-failed" | "delete-unsupported" | "stop-unsupported"

const PULL_FAILED: LocalProviderErrorCode = "pull-failed"
const DELETE_UNSUPPORTED: LocalProviderErrorCode = "delete-unsupported"
const STOP_UNSUPPORTED: LocalProviderErrorCode = "stop-unsupported"

export interface LocalPullState {
  status: "pulling" | "completed" | "error" | "cancelled"
  modelName: string
  /** Latest pull-progress event from the server (Cognia shape). */
  progress?: LocalModelPullProgress
  /** Convenience scalar 0–100. */
  percentage: number
  digest?: string
  /** A `LocalProviderErrorCode`, or raw server/exception text. */
  error?: string
  /** Cognia's flag — true while a pull is in flight. */
  isActive: boolean
  /**
   * True until the server sends byte counts. Ollama's opening lines
   * ("pulling manifest") carry no totals, so any percentage during that window
   * would be invented. Render a spinner, not a 0% bar.
   */
  indeterminate: boolean
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

/** Derive 0–100 from a progress line, or null while the server sends no totals. */
function percentageOf(progress: LocalModelPullProgress): number | null {
  const { completed, total } = progress as { completed?: number; total?: number }
  if (typeof completed !== "number" || typeof total !== "number" || total <= 0) {
    return null
  }
  return Math.min(100, Math.round((completed / total) * 100))
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

  /**
   * Detach handles for in-flight pulls, keyed by model. Held in a ref, not
   * state: unsubscribing must not re-render, and a stale closure over a state
   * Map would drop the handle of a pull started in an earlier render.
   */
  const pullHandles = useRef(new Map<string, () => void>())

  useEffect(() => {
    const handles = pullHandles.current
    // Detach every listener on unmount. The downloads themselves keep running
    // server-side — Ollama cannot cancel them — but leaking listeners into a
    // dead component would fire setState after unmount.
    return () => {
      handles.forEach((detach) => detach())
      handles.clear()
    }
  }, [])

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

  const pullModel = useCallback(
    async (modelName: string) => {
      if (!baseUrl) return
      setError(null)
      setPullStates((prev) => {
        const next = new Map(prev)
        next.set(modelName, {
          modelName,
          status: "pulling",
          percentage: 0,
          isActive: true,
          indeterminate: true,
        })
        return next
      })

      try {
        const service = createLocalProviderService(providerId, baseUrl)
        const handle = await service.pullModel(modelName, {
          onProgress: (progress) => {
            const pct = percentageOf(progress)
            setPullStates((prev) => {
              const next = new Map(prev)
              const cur = next.get(modelName)
              // A late event from a pull the user already dismissed must not
              // resurrect its row.
              if (!cur?.isActive) return prev
              next.set(modelName, {
                ...cur,
                progress,
                digest: (progress as { digest?: string }).digest ?? cur.digest,
                percentage: pct ?? cur.percentage,
                indeterminate: pct === null,
              })
              return next
            })
          },
        })
        pullHandles.current.set(modelName, handle.unsubscribe)

        setPullStates((prev) => {
          const next = new Map(prev)
          const cur = next.get(modelName)
          if (!cur?.isActive) return prev
          next.set(modelName, {
            ...cur,
            status: handle.success ? "completed" : "error",
            percentage: handle.success ? 100 : cur.percentage,
            indeterminate: false,
            isActive: false,
            error: handle.success ? undefined : PULL_FAILED,
          })
          return next
        })

        handle.unsubscribe()
        pullHandles.current.delete(modelName)
        if (handle.success) await refresh()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        setPullStates((prev) => {
          const next = new Map(prev)
          next.set(modelName, {
            modelName,
            status: "error",
            percentage: 0,
            error: message,
            isActive: false,
            indeterminate: false,
          })
          return next
        })
        pullHandles.current.get(modelName)?.()
        pullHandles.current.delete(modelName)
      }
    },
    [providerId, baseUrl, refresh]
  )

  /**
   * Stop REPORTING a pull. It does not stop the download.
   *
   * Ollama's server has no cancel: aborting the connection leaves the transfer
   * running to completion (ollama#13142). Callers must surface that to the user
   * rather than implying the bytes stopped — the UI copy for this state says
   * the download continues in the background.
   */
  const cancelPull = useCallback(async (modelName: string) => {
    pullHandles.current.get(modelName)?.()
    pullHandles.current.delete(modelName)
    setPullStates((prev) => {
      const next = new Map(prev)
      const cur = next.get(modelName) ?? {
        modelName,
        percentage: 0,
        status: "cancelled" as const,
        isActive: false,
        indeterminate: false,
      }
      next.set(modelName, { ...cur, status: "cancelled", isActive: false, indeterminate: false })
      return next
    })
  }, [])

  const deleteModel = useCallback(
    async (modelName: string) => {
      if (!baseUrl) return
      setError(null)
      try {
        const service = createLocalProviderService(providerId, baseUrl)
        const ok = await service.deleteModel(modelName)
        if (!ok) {
          setError(DELETE_UNSUPPORTED)
          return
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [providerId, baseUrl, refresh]
  )

  const stopModel = useCallback(
    async (modelName: string) => {
      if (!baseUrl) return
      setError(null)
      try {
        const service = createLocalProviderService(providerId, baseUrl)
        const ok = await service.stopModel(modelName)
        if (!ok) {
          setError(STOP_UNSUPPORTED)
          return
        }
        await refresh()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      }
    },
    [providerId, baseUrl, refresh]
  )

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
    pullModel,
    cancelPull,
    deleteModel,
    stopModel,
  }
}

/**
 * `useLocalProvidersScan` — Cognia's multi-provider auto-detect.
 *
 * Previously a hard-coded stub: an empty Map and a `noopScan` that resolved
 * without doing anything, which meant the Scan button in `LocalProviderSettings`
 * — whose only data source this is — did literally nothing.
 *
 * The identity discipline the stub relied on still matters and is preserved:
 * consumers thread `scan` into a mount `useEffect`, so `scan` must keep a
 * stable identity across renders or that effect re-fires forever. `useCallback`
 * with an empty dep list gives that; `detected`/`results` are state, so they
 * only change when a scan actually produces new data.
 */
export function useLocalProvidersScan() {
  const [results, setResults] = useState<Map<LocalProviderName, LocalServerStatus>>(() => new Map())
  const [isScanning, setIsScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Guards against overlapping scans — 10 providers × N clicks is a lot of probes. */
  const inFlight = useRef(false)

  const scan = useCallback(async (baseUrls?: Partial<Record<LocalProviderName, string>>) => {
    if (inFlight.current) return
    inFlight.current = true
    setIsScanning(true)
    setError(null)
    try {
      const checks = await checkAllProvidersInstallation(baseUrls)
      const next = new Map<LocalProviderName, LocalServerStatus>()
      for (const check of checks) {
        next.set(check.providerId, {
          connected: check.running,
          version: check.version,
          error: check.error,
        } as LocalServerStatus)
      }
      setResults(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      setIsScanning(false)
    }
  }, [])

  return {
    detected: results,
    /** Cognia's components also read this Map under the `results` alias. */
    results,
    isScanning,
    error,
    scan,
  }
}
