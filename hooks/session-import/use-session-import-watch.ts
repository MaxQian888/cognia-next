"use client"

// Live-sync toggle for external-agent session import (ADR-0062, T5). When
// enabled it (a) tells the Rust watcher which agent dirs to watch and (b)
// listens for `session-import://changed`, running a guarded background re-import
// on each debounced change. Desktop-only — a no-op off Tauri.

import { useCallback, useEffect, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { isTauri } from "@/lib/tauri"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { collectWatchRoots, runWatchImport } from "@/lib/session-import/watch-import"

const CHANGED_EVENT = "session-import://changed"

export interface UseSessionImportWatchDeps {
  invoke?: typeof invoke
  listen?: typeof listen
  isTauri?: typeof isTauri
  collectWatchRoots?: typeof collectWatchRoots
  runWatchImport?: typeof runWatchImport
}

export function useSessionImportWatch(
  opts: { projectId?: string; deps?: UseSessionImportWatchDeps } = {}
) {
  const projectId = opts.projectId
  const d = opts.deps ?? {}
  const invokeFn = d.invoke ?? invoke
  const listenFn = d.listen ?? listen
  const isTauriFn = d.isTauri ?? isTauri
  const collectRoots = d.collectWatchRoots ?? collectWatchRoots
  const doImport = d.runWatchImport ?? runWatchImport

  const [enabled, setEnabled] = useState(false)
  const unlistenRef = useRef<UnlistenFn | null>(null)

  const stop = useCallback(async () => {
    safeUnlisten(unlistenRef.current)
    unlistenRef.current = null
    if (isTauriFn()) {
      try {
        await invokeFn("session_import_watch_stop")
      } catch {
        // Best-effort teardown.
      }
    }
    setEnabled(false)
  }, [invokeFn, isTauriFn])

  const start = useCallback(async () => {
    if (!isTauriFn()) return
    const roots = await collectRoots()
    await invokeFn("session_import_watch_start", { roots })
    unlistenRef.current = await listenFn<{ path?: string }>(CHANGED_EVENT, (event) => {
      void doImport({ changedPath: event.payload?.path, projectId })
    })
    setEnabled(true)
  }, [invokeFn, listenFn, isTauriFn, collectRoots, doImport, projectId])

  const toggle = useCallback(
    async (on: boolean) => {
      if (on) await start()
      else await stop()
    },
    [start, stop]
  )

  // Tear the listener down on unmount so a closed panel stops re-importing.
  useEffect(() => {
    return () => safeUnlisten(unlistenRef.current)
  }, [])

  return { enabled, toggle }
}
