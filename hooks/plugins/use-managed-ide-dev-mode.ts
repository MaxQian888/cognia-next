"use client"

/**
 * Managed IDE Dev Mode state for React: the host switch, the session's
 * permission simulations and the registered plugin folders, re-read from the
 * host on mount (the host is authoritative; a reloaded renderer starts from
 * whatever it says).
 */

import { useEffect, useSyncExternalStore } from "react"

import {
  devFolders,
  devModeStatus,
  devModeVersion,
  readDevModeStatus,
  simulatedPermissions,
  subscribeDevMode,
} from "@/lib/plugin/ide/dev-mode"

export function useManagedIdeDevMode() {
  useSyncExternalStore(subscribeDevMode, devModeVersion, devModeVersion)
  useEffect(() => {
    // Off is the safe reading when the host cannot be reached.
    void readDevModeStatus().catch(() => undefined)
  }, [])
  return {
    status: devModeStatus(),
    simulations: simulatedPermissions(),
    folders: devFolders(),
  }
}
