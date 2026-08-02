"use client"

import type {
  ProviderBalanceSnapshot,
  ProviderBalanceSource,
  ProviderDiagnosticCapability,
  ProviderDiagnosticJob,
  ProviderDiagnosticMode,
  ProviderDiagnosticSample,
} from "@cognia/provider-types"

import { transport } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import type { Transport } from "@/lib/tauri/transport-types"

const CACHE_PREFIX = "cognia:provider-diagnostics:v1"

export interface RemoteProviderDiagnosticsStatus {
  capturedAt: number
  desktopRevision: number
  stale: boolean
  jobs: ProviderDiagnosticJob[]
  balanceSnapshots: ProviderBalanceSnapshot[]
  balanceSources: ProviderBalanceSource[]
}

export interface RemoteProviderDiagnosticsHistory {
  capturedAt: number
  desktopRevision: number
  stale: boolean
  samples: Array<Omit<ProviderDiagnosticSample, "endpoint">>
}

interface CacheStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface RemoteClientDependencies {
  transport?: Transport
  storage?: CacheStorage | null
  cacheScope?: string
}

export interface RemoteProviderDiagnosticSelection {
  providerId: string
  modelId?: string
  capability: ProviderDiagnosticCapability
}

function storageOrNull(storage?: CacheStorage | null): CacheStorage | null {
  if (storage !== undefined) return storage
  return typeof localStorage === "undefined" ? null : localStorage
}

function cacheScope(explicit?: string): string {
  if (explicit) return explicit
  const config = loadCompanionConfig()
  return config ? `${config.deviceId}:${config.serverFingerprint ?? config.baseUrl}` : "unpaired"
}

function cacheKey(
  kind: "status" | "history",
  providerId: string | undefined,
  explicitScope?: string
): string {
  return `${CACHE_PREFIX}:${encodeURIComponent(cacheScope(explicitScope))}:${kind}:${encodeURIComponent(providerId ?? "all")}`
}

function readCache<T extends { stale: boolean }>(
  storage: CacheStorage | null,
  key: string
): T | null {
  if (!storage) return null
  try {
    const value = JSON.parse(storage.getItem(key) ?? "null") as T | null
    return value ? { ...value, stale: true } : null
  } catch {
    return null
  }
}

function writeCache<T>(storage: CacheStorage | null, key: string, value: T): void {
  if (!storage) return
  try {
    storage.setItem(key, JSON.stringify(value))
  } catch {
    // A diagnostic cache is best-effort; quota and privacy-mode failures must
    // not turn a successful desktop response into an application error.
  }
}

export function getCachedRemoteProviderDiagnosticsStatus(
  providerId?: string,
  dependencies: RemoteClientDependencies = {}
): RemoteProviderDiagnosticsStatus | null {
  return readCache(
    storageOrNull(dependencies.storage),
    cacheKey("status", providerId, dependencies.cacheScope)
  )
}

export function getCachedRemoteProviderDiagnosticsHistory(
  providerId?: string,
  dependencies: RemoteClientDependencies = {}
): RemoteProviderDiagnosticsHistory | null {
  return readCache(
    storageOrNull(dependencies.storage),
    cacheKey("history", providerId, dependencies.cacheScope)
  )
}

export async function fetchRemoteProviderDiagnosticsStatus(
  providerId?: string,
  dependencies: RemoteClientDependencies = {}
): Promise<RemoteProviderDiagnosticsStatus> {
  const storage = storageOrNull(dependencies.storage)
  const key = cacheKey("status", providerId, dependencies.cacheScope)
  try {
    const result = await (
      dependencies.transport ?? transport
    ).call<RemoteProviderDiagnosticsStatus>(
      "provider_diagnostics_status",
      providerId ? { providerId } : {}
    )
    const projection = { ...result, stale: false }
    writeCache(storage, key, projection)
    return projection
  } catch (error) {
    const cached = readCache<RemoteProviderDiagnosticsStatus>(storage, key)
    if (cached) return cached
    throw error
  }
}

export async function fetchRemoteProviderDiagnosticsHistory(
  input: { providerId?: string; limit?: number } = {},
  dependencies: RemoteClientDependencies = {}
): Promise<RemoteProviderDiagnosticsHistory> {
  const storage = storageOrNull(dependencies.storage)
  const key = cacheKey("history", input.providerId, dependencies.cacheScope)
  try {
    const result = await (
      dependencies.transport ?? transport
    ).call<RemoteProviderDiagnosticsHistory>("provider_diagnostics_history", {
      ...(input.providerId ? { providerId: input.providerId } : {}),
      limit: Math.max(1, Math.min(200, Math.floor(input.limit ?? 200))),
    })
    const projection = { ...result, stale: false }
    writeCache(storage, key, projection)
    return projection
  } catch (error) {
    const cached = readCache<RemoteProviderDiagnosticsHistory>(storage, key)
    if (cached) return cached
    throw error
  }
}

export async function startRemoteProviderDiagnosticJob(
  input: {
    targets: RemoteProviderDiagnosticSelection[]
    mode: ProviderDiagnosticMode
    costConfirmed: boolean
    confirmedRequestLimit: number
    confirmedMaxEstimatedCostUsd: number
  },
  dependencies: Pick<RemoteClientDependencies, "transport"> = {}
): Promise<{ accepted: true; jobId: string }> {
  return (dependencies.transport ?? transport).call("provider_diagnostics_start", input)
}

export async function cancelRemoteProviderDiagnosticJob(
  jobId: string,
  dependencies: Pick<RemoteClientDependencies, "transport"> = {}
): Promise<{ cancelled: boolean }> {
  return (dependencies.transport ?? transport).call("provider_diagnostics_cancel", { jobId })
}
