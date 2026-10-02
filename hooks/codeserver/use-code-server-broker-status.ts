"use client"

import { useEffect, useState } from "react"

import {
  CODESERVER_EVENTS,
  codeServerClient,
  type CodeServerBrokerStatus,
  type CodeServerEditorEvent,
} from "@/lib/codeserver/client"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

/** How often to look again while the workbench is still starting. */
export const BROKER_STATUS_STARTUP_POLL_MS = 3_000

const trimTrailingSlashes = (path: string) => path.replace(/\/+$/, "")

/**
 * Whether agent drive is available in the managed Pro IDE at `root`.
 *
 * The workbench keeps running when the broker cannot (kill switch, failed
 * install, incompatible extension), so without this the user sees a working
 * VS Code whose Cognia features silently do nothing. Read from the status the
 * host already reports, then re-read whenever the answer can change: a broker
 * issue is recorded, the extension connects (which clears one), or the
 * instance is still starting and has no answer yet.
 *
 * `null` until known, and for anything but a running managed instance.
 */
export function useCodeServerBrokerStatus(
  enabled: boolean,
  root: string
): CodeServerBrokerStatus | null {
  // Keyed by root, so an answer about the previous workspace is never shown
  // for the next one while its first read is in flight.
  const [answer, setAnswer] = useState<{
    root: string
    status: CodeServerBrokerStatus | null
  } | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const unlisteners: Array<() => void> = []
    const same = (other: string) => trimTrailingSlashes(other) === trimTrailingSlashes(root)

    const refresh = async () => {
      clearTimeout(timer)
      try {
        const next = await codeServerClient.status(root)
        if (cancelled) return
        setAnswer({ root, status: next.running ? (next.broker ?? null) : null })
        // Nothing to report until the instance is up; ask again shortly.
        if (!next.running) timer = setTimeout(() => void refresh(), BROKER_STATUS_STARTUP_POLL_MS)
      } catch {
        if (cancelled) return
        setAnswer({ root, status: null })
        timer = setTimeout(() => void refresh(), BROKER_STATUS_STARTUP_POLL_MS)
      }
    }

    const listen = <T>(event: string, handler: (payload: T) => void) => {
      void onTauriEvent<T>(event, (payload) => {
        if (!cancelled) handler(payload)
      }).then((fn) => {
        if (cancelled) fn()
        else unlisteners.push(fn)
      })
    }
    listen<{ root: string }>(CODESERVER_EVENTS.brokerIssue, (event) => {
      if (same(event.root)) void refresh()
    })
    listen<CodeServerEditorEvent>(CODESERVER_EVENTS.editorEvent, (event) => {
      if (event.name === "bridgeConnected" && same(event.root)) void refresh()
    })
    void refresh()

    return () => {
      cancelled = true
      clearTimeout(timer)
      for (const fn of unlisteners) safeUnlisten(fn)
    }
  }, [enabled, root])

  return enabled && answer?.root === root ? answer.status : null
}
