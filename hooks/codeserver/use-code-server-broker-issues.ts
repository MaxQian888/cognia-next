"use client"

import { useEffect, useRef } from "react"

import { CODESERVER_EVENTS, type CodeServerBrokerIssueEvent } from "@/lib/codeserver/client"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

const trimTrailingSlashes = (path: string) => path.replace(/\/+$/, "")

/**
 * Report broker problems for `root` as they happen.
 *
 * The host fires `codeserver://broker-issue` when the managed broker cannot
 * serve this workbench: the bundled extension failed its integrity check or
 * install, its credential file could not be written, it speaks no protocol
 * major the host does, or its single-use credential was used by two parties.
 * The first three leave the workbench running without agent drive; the last
 * means something besides the Cognia extension read the credential file, and
 * the host has already revoked it and issued a new one. Before this, all four
 * were a log line.
 */
export function useCodeServerBrokerIssues(
  enabled: boolean,
  root: string,
  onIssue: (event: CodeServerBrokerIssueEvent) => void
): void {
  const onIssueRef = useRef(onIssue)
  useEffect(() => {
    onIssueRef.current = onIssue
  }, [onIssue])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unlisten: (() => void) | null = null
    void onTauriEvent<CodeServerBrokerIssueEvent>(CODESERVER_EVENTS.brokerIssue, (event) => {
      if (cancelled) return
      if (trimTrailingSlashes(event.root) !== trimTrailingSlashes(root)) return
      onIssueRef.current(event)
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [enabled, root])
}
