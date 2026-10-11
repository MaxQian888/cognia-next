"use client"

import { useCallback, useEffect, useSyncExternalStore } from "react"

import { useRemoteHostActive } from "@/hooks/use-host-profile"
import { hasCapability } from "@/lib/platform/capabilities"
import { resolveHostingState, type HostingState } from "@/lib/platform/hosting"
import {
  HOST_MODE_OFF,
  hostModeLoaded,
  readHostMode,
  refreshHostMode,
  setHostMode,
  subscribeHostMode,
  type HostModeStatus,
} from "@/lib/tauri/host-mode"

export interface UseHostingStateResult {
  /** The desktop's host mode as Rust last reported it. */
  hostMode: HostModeStatus
  /** Whether host mode has been read yet; until then it reads as off. */
  loaded: boolean
  /** Whether this machine is actually hosting (`lib/platform/hosting.ts`). */
  state: HostingState
  /** Turn host mode on or off. Rejects when Rust could not persist it. */
  setEnabled: (enabled: boolean) => Promise<HostModeStatus>
}

/**
 * The React face of the hosting predicate: host mode from Rust, the static
 * `always-on` capability, and whether this shell is driving a remote host, all
 * subscribed so the answer moves when any of them does.
 */
export function useHostingState(): UseHostingStateResult {
  // The LOCAL baseline, not `useCapability`: that one also counts what a
  // paired server runs on this shell's behalf, and a phone is never the host.
  const hasAlwaysOn = hasCapability("always-on")
  const hostMode = useSyncExternalStore(subscribeHostMode, readHostMode, () => HOST_MODE_OFF)
  const loaded = useSyncExternalStore(subscribeHostMode, hostModeLoaded, () => false)
  const remoteActive = useRemoteHostActive()

  useEffect(() => {
    if (!hasAlwaysOn) return
    refreshHostMode().catch(() => undefined)
  }, [hasAlwaysOn])

  const setEnabled = useCallback((enabled: boolean) => setHostMode(enabled), [])

  return {
    hostMode,
    loaded: loaded || !hasAlwaysOn,
    state: resolveHostingState({ hostMode: hostMode.enabled, hasAlwaysOn, remoteActive }),
    setEnabled,
  }
}
