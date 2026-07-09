"use client"

/**
 * Module-level external store for the live fleet snapshot (`fleet://update`).
 *
 * One refcounted Tauri listener shared by every consumer (the island shell's
 * `useFleetStream` and the main window's attention aggregation). Backfills
 * via `fleet_get_snapshot` after subscribing; the `generatedAt` monotonic
 * guard keeps a newer live event from being clobbered by a stale backfill —
 * semantics carried over from the pre-migration effect in
 * `hooks/fleet/use-fleet-stream.ts`.
 */

import { createTauriEventStore, type TauriEventStore } from "@/lib/tauri/event-store"
import { fleetGetSnapshot } from "@/lib/tauri/fleet"
import { FLEET_UPDATE_EVENT, type FleetSnapshot } from "@/lib/fleet/types"

export const EMPTY_FLEET_SNAPSHOT: FleetSnapshot = { sessions: [], generatedAt: 0 }

export const fleetStreamStore: TauriEventStore<FleetSnapshot> = createTauriEventStore({
  event: FLEET_UPDATE_EVENT,
  initial: EMPTY_FLEET_SNAPSHOT,
  backfill: fleetGetSnapshot,
  applyBackfill: (current, fetched) =>
    current.generatedAt >= fetched.generatedAt ? current : fetched,
})
