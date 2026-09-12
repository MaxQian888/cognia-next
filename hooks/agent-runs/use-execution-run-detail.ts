"use client"

/**
 * The selected run's detail, live.
 *
 * Reads three things and hands them to the pure projection in
 * `lib/execution/run-detail-model.ts`: the run row (for its snapshot), the raw
 * journal, and the run's approvals.
 *
 * ## Private events, and why they are read here
 *
 * `resource.changed` is written `visibility: "private"` because it names
 * workspace paths and the snapshot is projected onto IM cards. That tier exists
 * to keep paths out of REMOTE projections, not out of the console running on
 * the machine that owns the workspace — so this hook passes `includePrivate`.
 *
 * ## Why `journalAvailable` exists
 *
 * `/agent-runs` is `companion: "remote"` (see `lib/runtime/surface-contract.ts`),
 * so it also renders on a paired phone. Mobile sync ships summaries; selected details are fetched from the host
 * through `execution_run_detail`, including immutable approval artifacts. An
 * empty Changes list there would claim "this run touched no files", which is a
 * different and much worse statement than "the journal is not on this device".
 * A run whose revision has moved but whose journal came back empty is exactly
 * that case, and the panel says so instead of showing a confident zero.
 */

import { useEffect, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { getCompanionConfigGeneration } from "@/lib/tauri/transport-companion"
import { useHostProfile } from "@/hooks/use-host-profile"
import { transport } from "@/lib/tauri"
import {
  getActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import {
  readExecutionRunDetailSources,
  type ExecutionRunDetailSources,
} from "@/lib/execution/run-detail-source"
import { projectRunDetail, type RunDetailProjection } from "@/lib/execution/run-detail-model"
import type { ExecutionRun, ExecutionRunInterrupt } from "@/types/execution/run"
import type { BotHandlerResultV1 } from "@/types/bot/run"

export interface ExecutionRunDetailState {
  run?: ExecutionRun
  detail: RunDetailProjection
  interrupts: ExecutionRunInterrupt[]
  botResult?: BotHandlerResultV1
  journalAvailable: boolean
  isLoading: boolean
}
const EMPTY_DETAIL: RunDetailProjection = {
  activities: [],
  omittedActivityCount: 0,
  artifacts: [],
  verifications: [],
  changes: [],
}
const serverTransport = () => null
function subscribePairing(listener: () => void) {
  window.addEventListener("cognia:companion-config-changed", listener)
  return () => window.removeEventListener("cognia:companion-config-changed", listener)
}

export function useExecutionRunDetail(runId: string | undefined): ExecutionRunDetailState {
  const profile = useHostProfile()
  const pairing = useSyncExternalStore(subscribePairing, getCompanionConfigGeneration, () => 0)
  const target = useSyncExternalStore(
    subscribeActiveRemoteTransport,
    getActiveRemoteTransport,
    serverTransport
  )
  const remote = Boolean(target) || profile === "mobile-companion" || profile === "cloud-companion"
  const local = useLiveQuery<ExecutionRunDetailSources | null>(
    async () => (runId ? readExecutionRunDetailSources(runId, !remote) : null),
    [runId, remote]
  )
  const [received, setReceived] = useState<{
    runId: string
    target: typeof target
    pairing: number
    data?: ExecutionRunDetailSources
    failed?: boolean
  }>()
  const revision = local?.run?.currentRevision

  useEffect(() => {
    if (!remote || !runId) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const data = await (target ?? transport).call<ExecutionRunDetailSources>(
          "execution_run_detail",
          { runId }
        )
        if (
          !data ||
          !Array.isArray(data.events) ||
          !Array.isArray(data.interrupts) ||
          (data.run && data.run.id !== runId)
        )
          throw new Error("Invalid run detail response")
        if (!stopped && pairing === getCompanionConfigGeneration())
          setReceived({ runId, target, pairing, data })
      } catch {
        // No stale approval buttons when the host disconnects or does not support this read.
        if (!stopped && pairing === getCompanionConfigGeneration())
          setReceived({ runId, target, pairing, failed: true })
      } finally {
        if (!stopped) timer = setTimeout(read, 3000)
      }
    }
    void read()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [runId, remote, target, pairing, revision])

  if (!runId)
    return { detail: EMPTY_DETAIL, interrupts: [], journalAvailable: true, isLoading: false }
  const current =
    received?.runId === runId && received.target === target && received.pairing === pairing
      ? received
      : undefined
  const sources = remote ? current?.data : local
  if (!sources)
    return {
      ...(local?.run ? { run: local.run } : {}),
      detail: projectRunDetail(local?.run?.latestSnapshot, []),
      interrupts: [],
      journalAvailable: !remote,
      isLoading: remote ? !current?.failed : local === undefined,
    }
  const run = sources.run
  const events = sources.events
  return {
    ...(run ? { run } : {}),
    detail: projectRunDetail(run?.latestSnapshot, events),
    interrupts: sources.interrupts,
    ...(sources.botResult ? { botResult: sources.botResult } : {}),
    journalAvailable: remote || !run || run.currentRevision === 0 || events.length > 0,
    isLoading: false,
  }
}
