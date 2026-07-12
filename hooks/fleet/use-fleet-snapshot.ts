"use client"

/**
 * useFleetSnapshot — the fleet snapshot for ANY surface, picking its source by
 * platform: the Tauri event store on desktop, the transport-backed remote store
 * on a companion-connected phone / browser, and an empty snapshot on an
 * unpaired plain web page. The desktop island keeps its dedicated
 * `useFleetStream`; this hook powers the cross-platform (mobile) fleet view.
 */

import { useSyncExternalStore } from "react"
import { isCapacitor, isTauri } from "@/lib/platform/detect"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { EMPTY_FLEET_SNAPSHOT, fleetStreamStore } from "@/lib/fleet/fleet-stream-store"
import { fleetRemoteStore } from "@/lib/fleet/fleet-remote-store"
import type { FleetSnapshot } from "@/lib/fleet/types"

export type FleetSnapshotSource = "tauri" | "companion" | "none"

export interface UseFleetSnapshotResult {
  snapshot: FleetSnapshot
  /** Which backend the snapshot came from — drives "connect first" UI. */
  source: FleetSnapshotSource
}

function pickSource(): FleetSnapshotSource {
  if (isTauri()) return "tauri"
  if (isCapacitor() || hasWebCompanionTarget()) return "companion"
  return "none"
}

const noopSubscribe = () => () => {}
const getEmptySnapshot = () => EMPTY_FLEET_SNAPSHOT

export function useFleetSnapshot(): UseFleetSnapshotResult {
  // Platform is stable per mount, so the chosen store's function identities
  // stay stable across renders (uSES requirement).
  const source = pickSource()
  const store =
    source === "tauri" ? fleetStreamStore : source === "companion" ? fleetRemoteStore : null

  const snapshot = useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : getEmptySnapshot,
    store ? store.getServerSnapshot : getEmptySnapshot
  )
  return { snapshot, source }
}
