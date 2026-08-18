"use client"

/**
 * Whether any IM connector is configured — the gate for IM affordances that
 * would otherwise appear on every message row (the "send to IM…" action).
 *
 * One `adapterInstances.count()` liveQuery for the whole window, shared through
 * `useSyncExternalStore`: it starts with the first subscriber and stops with the
 * last, so a thousand message rows cost one Dexie observer, not a thousand.
 * `adapterInstances` changes only when the operator adds / removes a
 * connector, so the observer is nearly always idle. The server snapshot is
 * `false`: static export never renders IM chrome.
 */

import { liveQuery, type Subscription } from "dexie"
import { useSyncExternalStore } from "react"

import { getDb } from "@/lib/db/schema"

let adapterCount: number | null = null
let subscription: Subscription | null = null
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function start(): void {
  subscription = liveQuery(() => getDb().adapterInstances.count()).subscribe({
    next: (count) => {
      adapterCount = count
      notify()
    },
    error: () => {
      // A failed read must not leave the row without a stable answer; treat
      // "unknown" as "none" rather than flapping.
      adapterCount = 0
      notify()
    },
  })
}

function stop(): void {
  subscription?.unsubscribe()
  subscription = null
}

export function subscribeImConfigured(listener: () => void): () => void {
  listeners.add(listener)
  if (!subscription) start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

export function getImConfiguredSnapshot(): boolean {
  return (adapterCount ?? 0) > 0
}

const getServerSnapshot = () => false

export function useImConfigured(): boolean {
  return useSyncExternalStore(subscribeImConfigured, getImConfiguredSnapshot, getServerSnapshot)
}

/** Test-only: drop the shared observer and cached count. */
export function __resetImConfiguredForTesting(): void {
  stop()
  listeners.clear()
  adapterCount = null
}
