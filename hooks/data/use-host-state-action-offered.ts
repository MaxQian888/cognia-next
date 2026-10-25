"use client"

/**
 * Whether the paired Host offers this caller a HostState intent, for the
 * menus and controls that would submit it. See
 * `lib/sync/host-state-offered-actions.ts`: unknown reads as offered, so a
 * desktop, an operator's device or a Host older than `supportedActions` keeps
 * every control it had.
 */

import { useSyncExternalStore } from "react"

import type { HostStateIntentKind } from "@cognia/agent-config-types/host-state"
import { useRuntimeSnapshot } from "@/hooks/use-runtime-snapshot"
import {
  hostStateActionOfferedHere,
  offeredHostStateActionsVersion,
  subscribeOfferedHostStateActions,
} from "@/lib/sync/host-state-offered-actions"

export function useHostStateActionOffered(kind: HostStateIntentKind): boolean {
  // Re-render on a new answer from the Host and on a pairing change.
  useSyncExternalStore(subscribeOfferedHostStateActions, offeredHostStateActionsVersion, () => 0)
  useRuntimeSnapshot()
  return hostStateActionOfferedHere(kind)
}
