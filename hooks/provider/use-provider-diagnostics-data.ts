"use client"

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import { isTauri } from "@/lib/tauri"
import { loadCompanionConfig } from "@/lib/tauri/transport-companion"
import { projectLegacyProviderBalanceRows } from "@/lib/provider-diagnostics/balance"
import {
  fetchRemoteProviderDiagnosticsHistory,
  fetchRemoteProviderDiagnosticsStatus,
  getCachedRemoteProviderDiagnosticsHistory,
  getCachedRemoteProviderDiagnosticsStatus,
  type RemoteProviderDiagnosticsHistory,
  type RemoteProviderDiagnosticsStatus,
} from "@/lib/provider-diagnostics/remote-client"
import { queryProviderDiagnosticHistory } from "@/lib/provider-diagnostics/store"
import type {
  ProviderBalanceSnapshot,
  ProviderDiagnosticJob,
  ProviderDiagnosticSample,
  ProviderEndpointChange,
} from "@cognia/provider-types"

/** How often a paired (non-desktop) client re-reads the desktop's snapshot. */
const REMOTE_POLL_MS = 10_000

/** How often the "is the newest sample stale?" clock ticks. */
const CLOCK_TICK_MS = 60_000

/** A sample older than this reads as stale on the desktop. */
const STALE_AFTER_MS = 15 * 60_000

export interface ProviderDiagnosticsData {
  /**
   * True when this runtime is a browser paired to a desktop over the companion
   * transport. Every mutation is owned by the desktop in that mode, so the UI
   * renders read-only and reads projections instead of Dexie.
   */
  pairedClient: boolean
  samples: ProviderDiagnosticSample[]
  /** `samples` narrowed to the rows that carry real measurements. */
  measuredSamples: ProviderDiagnosticSample[]
  latestSample: ProviderDiagnosticSample | undefined
  jobs: ProviderDiagnosticJob[]
  balances: ProviderBalanceSnapshot[]
  legacyBalanceProjection: ReturnType<typeof projectLegacyProviderBalanceRows>
  endpointChanges: ProviderEndpointChange[]
  remoteStatus: RemoteProviderDiagnosticsStatus | null
  remoteHistory: RemoteProviderDiagnosticsHistory | null
  /** Newest sample is old enough that the panel warns the user. */
  stale: boolean
  /** Ticks once a minute — the clock `stale` and range filters are computed against. */
  currentTime: number
  /** Force a remote re-read (after starting or cancelling a job from a paired client). */
  refreshRemoteStatus: () => Promise<void>
}

/**
 * Reads every data source the provider Diagnostics tab renders.
 *
 * Extracted from `provider-diagnostics-tab.tsx`, which mixed six live queries,
 * a polling effect, a clock and a paired-client branch into the same component
 * that laid out the seven sections. The split is what lets the sections be
 * plain presentational components.
 */
export function useProviderDiagnosticsData(providerId: string): ProviderDiagnosticsData {
  const pairedClient = !isTauri() && loadCompanionConfig() !== null

  const [remoteStatus, setRemoteStatus] = useState<RemoteProviderDiagnosticsStatus | null>(() =>
    pairedClient ? getCachedRemoteProviderDiagnosticsStatus(providerId) : null
  )
  const [remoteHistory, setRemoteHistory] = useState<RemoteProviderDiagnosticsHistory | null>(() =>
    pairedClient ? getCachedRemoteProviderDiagnosticsHistory(providerId) : null
  )
  const [currentTime, setCurrentTime] = useState(() => Date.now())

  const localSamples = useLiveQuery(
    () => queryProviderDiagnosticHistory({ providerId, limit: 500 }),
    [providerId],
    []
  )
  const localJobs = useLiveQuery(
    () =>
      getDb()
        .providerDiagnosticJobs.where("providerId")
        .equals(providerId)
        .reverse()
        .sortBy("startedAt"),
    [providerId],
    []
  )
  const localBalances = useLiveQuery(
    () =>
      getDb()
        .providerBalanceSnapshots.where("providerId")
        .equals(providerId)
        .reverse()
        .sortBy("fetchedAt"),
    [providerId],
    []
  )
  const legacyBalanceProjection = useLiveQuery(
    async () => {
      const [legacyBalances, legacyLimits] = await Promise.all([
        getDb()
          .subscriptionBalance.filter((row) => row.providerKey === providerId)
          .toArray(),
        getDb().providerLimits.where("provider").equals(providerId).toArray(),
      ])
      return projectLegacyProviderBalanceRows({
        providerId,
        balances: legacyBalances,
        limits: legacyLimits,
      })
    },
    [providerId],
    { sources: [], snapshots: [] }
  )
  const endpointChanges = useLiveQuery(
    () =>
      getDb()
        .providerEndpointChanges.where("providerId")
        .equals(providerId)
        .reverse()
        .sortBy("appliedAt"),
    [providerId],
    []
  )

  useEffect(() => {
    if (!pairedClient) return
    let active = true
    const refresh = async () => {
      const [nextStatus, nextHistory] = await Promise.all([
        fetchRemoteProviderDiagnosticsStatus(providerId),
        fetchRemoteProviderDiagnosticsHistory({ providerId, limit: 200 }),
      ])
      if (!active) return
      setRemoteStatus(nextStatus)
      setRemoteHistory(nextHistory)
    }
    void refresh().catch(() => undefined)
    const interval = window.setInterval(() => void refresh().catch(() => undefined), REMOTE_POLL_MS)
    // A backgrounded tab stops getting timely intervals; re-read on focus so the
    // panel is never showing a snapshot from before the user switched away.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void refresh().catch(() => undefined)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      active = false
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [pairedClient, providerId])

  useEffect(() => {
    const interval = window.setInterval(() => setCurrentTime(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(interval)
  }, [])

  const samples: ProviderDiagnosticSample[] = useMemo(
    () =>
      pairedClient
        ? (remoteHistory?.samples.map((sample) => ({ ...sample, endpoint: "" })) ?? [])
        : localSamples,
    [pairedClient, remoteHistory?.samples, localSamples]
  )
  const jobs = useMemo(
    () => (pairedClient ? (remoteStatus?.jobs ?? []) : localJobs),
    [pairedClient, remoteStatus?.jobs, localJobs]
  )
  const balances = useMemo(
    () => (pairedClient ? (remoteStatus?.balanceSnapshots ?? []) : localBalances),
    [localBalances, pairedClient, remoteStatus?.balanceSnapshots]
  )

  const measuredSamples = useMemo(
    () => samples.filter((sample) => sample.sampleRole === "measured"),
    [samples]
  )
  const latestSample = measuredSamples[0]

  // The desktop derives staleness from the sample clock; a paired client trusts
  // whatever the desktop reported, because its own clock proves nothing about
  // when the desktop last ran.
  const stale = pairedClient
    ? (remoteStatus?.stale ?? remoteHistory?.stale ?? false)
    : latestSample
      ? currentTime - latestSample.startedAt > STALE_AFTER_MS
      : false

  const refreshRemoteStatus = async () => {
    if (!pairedClient) return
    setRemoteStatus(await fetchRemoteProviderDiagnosticsStatus(providerId))
  }

  return {
    pairedClient,
    samples,
    measuredSamples,
    latestSample,
    jobs,
    balances,
    legacyBalanceProjection,
    endpointChanges,
    remoteStatus,
    remoteHistory,
    stale,
    currentTime,
    refreshRemoteStatus,
  }
}
