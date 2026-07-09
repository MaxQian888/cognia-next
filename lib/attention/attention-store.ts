"use client"

/**
 * Aggregation store for the Control Center: subscribes to the three pending
 * surfaces (chat approvals, team HITL gates, fleet snapshot) and exposes one
 * `AttentionItem[]` snapshot via the useSyncExternalStore contract.
 *
 * Read-only — it never mutates the upstream stores. Upstream subscriptions
 * attach on the first subscriber and detach on the last (the fleet stream's
 * Tauri listener is itself refcounted, so an idle app holds no listeners).
 * Recomputation is reference-diffed: chat streams update the sessions record
 * on every token, but the projection only rebuilds when a `pendingApprovals`
 * array, the gates array, or the fleet snapshot actually changes identity.
 */

import { useChatStore } from "@/stores/chat/chat-store"
import { usePendingGatesStore } from "@/stores/agent/pending-gates-store"
import { fleetStreamStore } from "@/lib/fleet/fleet-stream-store"
import { projectAttention } from "./project"
import type { AttentionItem } from "./types"

const EMPTY_ITEMS: readonly AttentionItem[] = Object.freeze([])

const listeners = new Set<() => void>()
let snapshot: readonly AttentionItem[] = EMPTY_ITEMS
let unsubscribers: Array<() => void> = []

/** Reference signature of the last projected inputs (cheap change detection). */
let lastApprovalRefs = new Map<string, readonly unknown[]>()
let lastGatesRef: readonly unknown[] | null = null
let lastFleetRef: unknown = null

function collectApprovalRefs(): Map<string, readonly unknown[]> {
  const refs = new Map<string, readonly unknown[]>()
  const sessions = useChatStore.getState().sessions
  for (const [id, slice] of Object.entries(sessions)) {
    if (slice.pendingApprovals.length > 0) refs.set(id, slice.pendingApprovals)
  }
  return refs
}

function approvalRefsChanged(next: Map<string, readonly unknown[]>): boolean {
  if (next.size !== lastApprovalRefs.size) return true
  for (const [id, arr] of next) {
    if (lastApprovalRefs.get(id) !== arr) return true
  }
  return false
}

function recompute(force = false): void {
  const approvalRefs = collectApprovalRefs()
  const gates = usePendingGatesStore.getState().gates
  const fleet = fleetStreamStore.getSnapshot()

  const changed =
    force || approvalRefsChanged(approvalRefs) || gates !== lastGatesRef || fleet !== lastFleetRef
  if (!changed) return

  lastApprovalRefs = approvalRefs
  lastGatesRef = gates
  lastFleetRef = fleet

  const chatSessions: Record<string, { pendingApprovals: readonly never[] }> = {}
  for (const [id, approvals] of approvalRefs) {
    chatSessions[id] = { pendingApprovals: approvals as readonly never[] }
  }
  const next = projectAttention({ chatSessions, gates, fleet })
  snapshot = next.length === 0 && snapshot.length === 0 ? snapshot : next
  for (const fn of listeners) fn()
}

function attach(): void {
  unsubscribers = [
    useChatStore.subscribe(() => recompute()),
    usePendingGatesStore.subscribe(() => recompute()),
    fleetStreamStore.subscribe(() => recompute()),
  ]
  recompute(true)
}

function detach(): void {
  for (const un of unsubscribers) un()
  unsubscribers = []
}

export function subscribeAttention(onChange: () => void): () => void {
  const cold = listeners.size === 0
  listeners.add(onChange)
  if (cold) attach()
  let active = true
  return () => {
    if (!active) return
    active = false
    listeners.delete(onChange)
    if (listeners.size === 0) detach()
  }
}

export function getAttentionSnapshot(): readonly AttentionItem[] {
  return snapshot
}

export function getAttentionServerSnapshot(): readonly AttentionItem[] {
  return EMPTY_ITEMS
}

export function resetAttentionForTests(): void {
  listeners.clear()
  detach()
  snapshot = EMPTY_ITEMS
  lastApprovalRefs = new Map()
  lastGatesRef = null
  lastFleetRef = null
}
