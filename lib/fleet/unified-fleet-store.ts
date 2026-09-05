"use client"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import { appendCanonicalEnvelopes } from "@/lib/ai/agent/recovery/canonical-log"
import { redactAgentEventEnvelope } from "@/lib/ai/agent/execution/event-envelope"
import { subscribeAgentEvents } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import type { TauriEventStore } from "@/lib/tauri/event-store"
import {
  CANONICAL_SESSION_LINGER_MS,
  canonicalSessionExpired,
  projectCanonicalFleetSession,
} from "./canonical-projection"
import { EMPTY_FLEET_SNAPSHOT, fleetStreamStore } from "./fleet-stream-store"
import type { FleetSession, FleetSnapshot } from "./types"

export function mergeFleetSnapshots(
  external: FleetSnapshot,
  canonical: ReadonlyMap<string, FleetSession>,
  generatedAt = external.generatedAt
): FleetSnapshot {
  const sessions: FleetSession[] = external.sessions.map((session) => ({
    ...session,
    origin: session.origin ?? ("external" as const),
  }))
  const keys = new Set(sessions.map((session) => `${session.agent}:${session.sessionId}`))
  for (const session of canonical.values()) {
    const key = `${session.agent}:${session.sessionId}`
    if (!keys.has(key)) sessions.push(session)
  }
  return { ...external, sessions, generatedAt: Math.max(external.generatedAt, generatedAt) }
}

function createUnifiedFleetStore(): TauriEventStore<FleetSnapshot> {
  const listeners = new Set<() => void>()
  const canonical = new Map<string, FleetSession>()
  let snapshot = EMPTY_FLEET_SNAPSHOT
  let detachExternal: (() => void) | undefined
  let detachCanonical: (() => void) | undefined
  let generation = 0
  /** Per-session sweep timers for finished rows. Keyed by canonical sessionId. */
  const sweeps = new Map<string, ReturnType<typeof setTimeout>>()

  const emit = () => listeners.forEach((listener) => listener())
  const cancelSweep = (sessionId: string) => {
    const timer = sweeps.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      sweeps.delete(sessionId)
    }
  }
  const refresh = () => {
    const latestCanonicalEvent = Math.max(
      0,
      ...Array.from(canonical.values(), (session) => session.lastEventAt)
    )
    snapshot = mergeFleetSnapshots(fleetStreamStore.getSnapshot(), canonical, latestCanonicalEvent)
    emit()
  }
  /**
   * Drop canonical rows whose result state has expired.
   *
   * Runs on the sweep timer and again on every resubscribe, because a store
   * that was detached while a session ended has no timer left to fire and would
   * otherwise resurrect a finished row on the next mount.
   */
  const evictExpired = (now = Date.now()): boolean => {
    let changed = false
    for (const [sessionId, session] of canonical) {
      if (!canonicalSessionExpired(session, now)) continue
      canonical.delete(sessionId)
      cancelSweep(sessionId)
      changed = true
    }
    return changed
  }
  const onEnvelope = (raw: AgentEventEnvelope) => {
    const envelope = redactAgentEventEnvelope(raw)
    const next = projectCanonicalFleetSession(canonical.get(envelope.sessionId), envelope)
    canonical.set(envelope.sessionId, next)
    // A session that starts again cancels the pending sweep of its previous
    // ending, so a restarted run is never swept out from under itself.
    cancelSweep(envelope.sessionId)
    if (next.status === "ended") {
      sweeps.set(
        envelope.sessionId,
        setTimeout(() => {
          sweeps.delete(envelope.sessionId)
          if (evictExpired()) refresh()
        }, CANONICAL_SESSION_LINGER_MS + 100)
      )
    }
    void appendCanonicalEnvelopes(envelope.runId, [envelope])
    refresh()
  }

  const attach = () => {
    const currentGeneration = generation
    evictExpired()
    detachExternal = fleetStreamStore.subscribe(refresh)
    refresh()
    void subscribeAgentEvents(onEnvelope).then((unlisten) => {
      if (currentGeneration !== generation) unlisten()
      else detachCanonical = unlisten
    })
  }
  const detach = () => {
    generation += 1
    detachExternal?.()
    detachCanonical?.()
    detachExternal = undefined
    detachCanonical = undefined
    for (const timer of sweeps.values()) clearTimeout(timer)
    sweeps.clear()
  }

  return {
    subscribe(listener) {
      if (!isTauri()) return () => {}
      const cold = listeners.size === 0
      listeners.add(listener)
      if (cold) attach()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) detach()
      }
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY_FLEET_SNAPSHOT,
    resetForTests() {
      listeners.clear()
      detach()
      canonical.clear()
      snapshot = EMPTY_FLEET_SNAPSHOT
    },
  }
}

export const unifiedFleetStore = createUnifiedFleetStore()
