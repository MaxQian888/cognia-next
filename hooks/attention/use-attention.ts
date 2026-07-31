"use client"

/**
 * React bindings for the Control Center attention aggregation
 * (`lib/attention/attention-store.ts`).
 */

import { useSyncExternalStore } from "react"
import {
  subscribeAttention,
  getAttentionSnapshot,
  getAttentionServerSnapshot,
} from "@/lib/attention/attention-store"
import { liveAttentionCount } from "@/lib/attention/project"
import type { AttentionItem } from "@/lib/attention/types"

export function useAttentionItems(): readonly AttentionItem[] {
  return useSyncExternalStore(subscribeAttention, getAttentionSnapshot, getAttentionServerSnapshot)
}

/** Count of live (answerable) items — drives the status-bar badge. */
export function useAttentionCount(): number {
  return liveAttentionCount(useAttentionItems())
}
