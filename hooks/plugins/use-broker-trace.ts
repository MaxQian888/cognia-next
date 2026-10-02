"use client"

/**
 * The Managed IDE Dev Mode broker trace, live: what the host recorded so far,
 * then every new frame from `codeserver://broker-trace`. Each request row is
 * joined to the renderer's own record of it (`getManagedIdeRpcTraces`, keyed
 * by root, generation and request id) to mark the ones decided under a
 * simulated permission.
 *
 * Off (Dev Mode off), it shows nothing and listens to nothing.
 */

import { useEffect, useMemo, useState } from "react"

import {
  codeServerClient,
  CODESERVER_EVENTS,
  type CodeServerBrokerTraceEntry,
} from "@/lib/codeserver/client"
import { getManagedIdeRpcTraces } from "@/lib/plugin/ide/broker-runtime"
import { onTauriEvent } from "@/lib/tauri/events"

/** Mirrors the host ring (`broker_trace::TRACE_CAPACITY`). */
export const BROKER_TRACE_ROWS = 2_000

export interface BrokerTraceRow extends CodeServerBrokerTraceEntry {
  simulated: boolean
}

function append(
  current: CodeServerBrokerTraceEntry[],
  incoming: CodeServerBrokerTraceEntry[]
): CodeServerBrokerTraceEntry[] {
  const last = current.at(-1)?.seq ?? 0
  const fresh = incoming.filter((entry) => entry.seq > last)
  const next = fresh.length === 0 ? current : [...current, ...fresh]
  return next.length > BROKER_TRACE_ROWS ? next.slice(-BROKER_TRACE_ROWS) : next
}

export function useBrokerTrace(enabled: boolean): {
  rows: BrokerTraceRow[]
  error: string | null
} {
  const [entries, setEntries] = useState<CodeServerBrokerTraceEntry[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let active = true
    let unlisten: (() => void) | undefined
    void onTauriEvent<CodeServerBrokerTraceEntry>(CODESERVER_EVENTS.brokerTrace, (entry) => {
      if (active) setEntries((current) => append(current, [entry]))
    })
      .then((off) => {
        if (active) unlisten = off
        else off()
      })
      .catch(() => undefined)
    codeServerClient
      .brokerTrace()
      .then((recorded) => {
        if (!active) return
        setError(null)
        // What the host holds is the start; anything already streamed in is newer.
        setEntries((current) => append(recorded, current))
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      active = false
      unlisten?.()
      setEntries([])
    }
  }, [enabled])

  const rows = useMemo(() => {
    if (!enabled) return []
    const simulated = new Set(
      getManagedIdeRpcTraces()
        .filter((trace) => trace.simulated)
        .map((trace) => `${trace.root}\0${trace.generation}\0${trace.requestId}`)
    )
    return entries.map((entry) => ({
      ...entry,
      simulated:
        entry.id !== null && simulated.has(`${entry.root}\0${entry.generation}\0${entry.id}`),
    }))
  }, [enabled, entries])

  return { rows, error: enabled ? error : null }
}
