/**
 * Capture-only store for the sidecar's `ready` payload (SDK version, sidecar
 * version, ready flag). Subscribes to `onClaudeMessage` once on first read
 * via `useSyncExternalStore`, so component callers don't have to remember
 * to install the listener themselves.
 *
 * Stage 5 of the ClaudeCode 完整化 plan. Surfaces in `sidecar-tab.tsx`'s
 * status card and the cross-section Related strip.
 */

"use client"

import { useSyncExternalStore } from "react"
import { onClaudeMessage } from "@/lib/claude/ipc"
import type { ReadyEvent } from "@cognia/agent-config-types"
import { isTauri } from "@/lib/tauri"

export interface SidecarInfo {
  /** True when the sidecar has emitted at least one `ready` event in this
   *  process. Survives sidecar restarts because the next `ready` re-flips it. */
  ready: boolean
  /** `@anthropic-ai/claude-agent-sdk` version reported by the sidecar. */
  sdkVersion?: string
  /** Sidecar package.json version. */
  sidecarVersion?: string
}

const INITIAL: SidecarInfo = { ready: false }

let current: SidecarInfo = INITIAL
const listeners = new Set<() => void>()
let unlisten: (() => void) | null = null
let installing: Promise<void> | null = null

function emit() {
  for (const listener of listeners) listener()
}

function ingest(evt: { type: string }) {
  if (evt.type !== "ready") return
  const ready = evt as ReadyEvent
  current = {
    ready: true,
    sdkVersion: ready.sdkVersion,
    sidecarVersion: ready.sidecarVersion,
  }
  emit()
}

async function ensureListener() {
  if (unlisten || installing) return
  if (!isTauri()) return
  installing = (async () => {
    try {
      const off = await onClaudeMessage((evt) => ingest(evt as { type: string }))
      unlisten = off
    } catch {
      // Tauri event setup can fail in unusual harnesses (web mode, missing
      // backend). Tolerate — the ready badge degrades to "unknown".
    } finally {
      installing = null
    }
  })()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  void ensureListener()
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): SidecarInfo {
  return current
}

/**
 * React hook returning the latest sidecar info captured from `ready` events.
 * Returns `{ ready: false }` until the first `ready` arrives — components
 * should treat absent fields as "not yet known" rather than "missing".
 */
export function useSidecarInfo(): SidecarInfo {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Test-only reset. Production callers should never need to clear the cache —
 * the sidecar emits a fresh `ready` on every restart and that re-populates
 * `current`.
 */
export function __resetSidecarInfoForTesting(): void {
  current = INITIAL
  listeners.clear()
  unlisten?.()
  unlisten = null
  installing = null
}

/**
 * Test-only hook to inject a synthetic ready event without going through the
 * Tauri transport.
 */
export function __injectReadyForTesting(evt: ReadyEvent): void {
  ingest(evt)
}
