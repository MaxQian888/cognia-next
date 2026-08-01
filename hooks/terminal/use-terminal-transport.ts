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
 */

import { useSyncExternalStore } from "react"

import {
  selectTerminalTransport,
  selectTerminalTransportChain,
  type TerminalTransportKind,
} from "@/lib/terminal/pick-transport"
import { subscribeActiveRemoteTransport } from "@/lib/tauri/transport-routing"

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

export function useTerminalTransport(): TerminalTransportState {
  return useSyncExternalStore(subscribeActiveRemoteTransport, snapshot, serverSnapshot)
}

/** Test-only: drop the memoised snapshots so a re-stubbed shell is observed. */
export function __resetTerminalTransportSnapshotsForTests(): void {
  SNAPSHOTS.clear()
}

export default useTerminalTransport
