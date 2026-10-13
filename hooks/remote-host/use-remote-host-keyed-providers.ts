"use client"

import { useSyncExternalStore } from "react"

import {
  remoteHostKeyedProviders,
  subscribeRemoteHostKeyedProviders,
} from "@/lib/host-secrets/remote-host-keys"

const NONE: ReadonlySet<string> = new Set()

/**
 * The providers the driven `/pair` Host holds a sealed key for (ADR-0224 A6),
 * re-read whenever that list changes. Empty while no such Host is driven.
 */
export function useRemoteHostKeyedProviders(): ReadonlySet<string> {
  return useSyncExternalStore(
    subscribeRemoteHostKeyedProviders,
    remoteHostKeyedProviders,
    () => NONE
  )
}
