"use client"

import { useSyncExternalStore } from "react"

import {
  getRuntimeSnapshot,
  getServerRuntimeSnapshot,
  subscribeRuntimeSnapshot,
} from "@/lib/runtime/runtime-snapshot-store"

export function useRuntimeSnapshot() {
  return useSyncExternalStore(
    subscribeRuntimeSnapshot,
    getRuntimeSnapshot,
    getServerRuntimeSnapshot
  )
}
