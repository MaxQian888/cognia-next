"use client"

import { useSyncExternalStore } from "react"

import {
  getInstallStatus,
  promptInstall,
  subscribeInstallState,
  type PwaInstallOutcome,
  type PwaInstallStatus,
} from "@/lib/pwa/install-state"

export interface UseInstallPromptResult {
  status: PwaInstallStatus
  /** Show the browser install dialog; resolves the user's choice. */
  install: () => Promise<PwaInstallOutcome>
}

const getServerStatus = (): PwaInstallStatus => "unavailable"

/**
 * React view over `lib/pwa/install-state`. Read-only for SSR — the server
 * snapshot is `unavailable` and the client resolves the real status on first
 * paint (and again when `beforeinstallprompt` / `appinstalled` / display-mode
 * changes fire).
 */
export function useInstallPrompt(): UseInstallPromptResult {
  const status = useSyncExternalStore(subscribeInstallState, getInstallStatus, getServerStatus)
  return { status, install: promptInstall }
}
