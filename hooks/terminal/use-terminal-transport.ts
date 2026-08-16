"use client"

/**
 * Reactive view of the terminal transport for the current shell.
 *
 * `selectTerminalTransport()` is a plain function read at call time, which the
 * dock used to do during render. That made the dock's affordances stale the
 * moment a remote Cognia host was activated or dropped mid-session — the panel
 * kept whichever transport happened to be current when it last re-rendered for
 * some other reason. This hook subscribes to the same activation signal the
 * resolver reads, so the dock re-renders when the answer changes.
 *
 * It also exposes `canSpawn`, which is the predicate the affordances actually
 * want. Gating "+ New" on `kind === "tauri-channel"` meant a desktop driving a
 * remote host got a dock with no way to create a terminal at all, even though
 * `spawnFromDock` walks the very chain this reads and works fine over `ws`.
 *
 * Two independent signals can move the answer, so both are subscribed:
 * activating/dropping a remote Cognia host (ADR-0082) and pairing/unpairing a
 * cloud companion (ADR-0059 C1). The latter only writes localStorage, which
 * fires no React update of its own — `cognia:companion-config-changed` is the
 * canonical broadcast the companion boot providers already listen on.
 */

import { useSyncExternalStore } from "react"

import {
  selectTerminalTransport,
  selectTerminalTransportChain,
  type TerminalTransportKind,
} from "@/lib/terminal/pick-transport"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

/** Broadcast by every companion-pairing write (`lib/tauri/transport-companion.ts`). */
const COMPANION_CONFIG_CHANGED_EVENT = "cognia:companion-config-changed"

export interface TerminalTransportState {
  /** Preferred transport for a new session. */
  kind: TerminalTransportKind
  /**
   * True when a session can actually be created — i.e. the spawn chain
   * `pickSpawnChain()` walks is non-empty. This, not `kind`, is what spawn
   * affordances gate on.
   */
  canSpawn: boolean
  /**
   * True only for the in-process Tauri PTY. Gates local-only affordances such
   * as the PATH executable scan behind the shell picker.
   */
  isLocalPty: boolean
}

/**
 * `useSyncExternalStore` requires a snapshot that is referentially stable
 * between changes, or React re-renders forever. The transport is derived from
 * process-wide module state with no object identity of its own, so cache one
 * frozen value per `kind` and hand the same object back until the kind moves.
 */
const SNAPSHOTS = new Map<TerminalTransportKind, TerminalTransportState>()

const SERVER_SNAPSHOT: TerminalTransportState = Object.freeze({
  kind: "unsupported" as const,
  canSpawn: false,
  isLocalPty: false,
})

function snapshot(): TerminalTransportState {
  const kind = selectTerminalTransport()
  const cached = SNAPSHOTS.get(kind)
  if (cached) return cached
  const next: TerminalTransportState = Object.freeze({
    kind,
    canSpawn: selectTerminalTransportChain().length > 0,
    isLocalPty: kind === "tauri-channel",
  })
  SNAPSHOTS.set(kind, next)
  return next
}

/**
 * Server snapshot for the static export: during SSR / pre-hydration the shell
 * detectors all report "web", so pin the answer rather than letting the cache
 * memoise a `kind` that hydration is about to contradict.
 */
function serverSnapshot(): TerminalTransportState {
  return SERVER_SNAPSHOT
}

/**
 * Fan out to both activation signals. `useSyncExternalStore` takes one
 * subscribe function, and it must be referentially stable or React resubscribes
 * on every render — so this is a module-level function, not a closure.
 *
 * No `typeof window` guard: React only ever calls `subscribe` from an effect,
 * which never runs during the static export's server pass. SSR is served by
 * {@link serverSnapshot} instead.
 */
function subscribeTransportChanges(onStoreChange: () => void): () => void {
  const unsubscribeRemoteHost = subscribeActiveRemoteTransport(onStoreChange)
  window.addEventListener(COMPANION_CONFIG_CHANGED_EVENT, onStoreChange)
  return () => {
    window.removeEventListener(COMPANION_CONFIG_CHANGED_EVENT, onStoreChange)
    unsubscribeRemoteHost()
  }
}

export function useTerminalTransport(): TerminalTransportState {
  return useSyncExternalStore(subscribeTransportChanges, snapshot, serverSnapshot)
}

/** Test-only: drop the memoised snapshots so a re-stubbed shell is observed. */
export function __resetTerminalTransportSnapshotsForTests(): void {
  SNAPSHOTS.clear()
}

export default useTerminalTransport
