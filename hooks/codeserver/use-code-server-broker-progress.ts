"use client"

import { useEffect, useState } from "react"

import {
  CODESERVER_EVENTS,
  type CodeServerBrokerProgress,
  type CodeServerEditorEvent,
} from "@/lib/codeserver/client"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/**
 * How long an operation may go without a report before it is presumed over.
 *
 * Every report renews the host's deadline for the request, but only up to
 * two minutes past its own (`MAX_PROGRESS_EXTENSION` in
 * `crates/cognia-codeserver/src/broker_protocol.rs`): a request silent for
 * longer than that has been answered or withdrawn whether or not its `end`
 * report arrived.
 */
export const STALE_PROGRESS_MS = 150_000

export type BrokerProgressValue = CodeServerBrokerProgress["value"]

const trimTrailingSlashes = (path: string) => path.replace(/\/+$/, "")

/**
 * The editor operations the agent is waiting on in the Pro IDE at `root`, most
 * recent first.
 *
 * The extension reports `$/progress` for the slow verbs (applying an edit,
 * saving every file, activating a plugin's proxy); the host forwards each one
 * as a `brokerProgress` editor event. Before this nothing showed them, so a
 * save of forty files looked exactly like a hung agent.
 *
 * An operation leaves the list on its `end` report, after
 * {@link STALE_PROGRESS_MS} without one, or when the extension reconnects (a
 * dropped connection aborted everything it was doing).
 */
export function useCodeServerBrokerProgress(enabled: boolean, root: string): BrokerProgressValue[] {
  const [operations, setOperations] = useState<
    Map<string, { value: BrokerProgressValue; at: number }>
  >(() => new Map())

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const drop = (key: string) => {
      clearTimeout(timers.get(key))
      timers.delete(key)
      setOperations((current) => {
        if (!current.has(key)) return current
        const next = new Map(current)
        next.delete(key)
        return next
      })
    }
    const clearAll = () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      setOperations((current) => (current.size === 0 ? current : new Map()))
    }

    void onTauriEvent<CodeServerEditorEvent>(CODESERVER_EVENTS.editorEvent, (event) => {
      if (cancelled) return
      if (trimTrailingSlashes(event.root) !== trimTrailingSlashes(root)) return
      if (event.name === "bridgeConnected") {
        clearAll()
        return
      }
      if (event.name !== "brokerProgress") return
      const progress = event.payload as unknown as CodeServerBrokerProgress | null
      if (!progress || progress.token == null || !progress.value) return
      const key = String(progress.token)
      if (progress.value.kind === "end") {
        drop(key)
        return
      }
      clearTimeout(timers.get(key))
      timers.set(
        key,
        setTimeout(() => drop(key), STALE_PROGRESS_MS)
      )
      setOperations((current) => {
        const next = new Map(current)
        next.set(key, { value: progress.value, at: Date.now() })
        return next
      })
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
      clearAll()
    }
  }, [enabled, root])

  return [...operations.values()].sort((a, b) => b.at - a.at).map((entry) => entry.value)
}
