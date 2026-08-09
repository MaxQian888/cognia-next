"use client"

import type { AgentEventEnvelope } from "@cognia/agent-config-types/agent-execution"

import { appendCanonicalEnvelopes } from "@/lib/ai/agent/recovery/canonical-log"
import { redactAgentEventEnvelope } from "@/lib/ai/agent/execution/event-envelope"
import { subscribeAgentEvents } from "@/lib/claude/ipc"
import { isTauri } from "@/lib/tauri"
import type { TauriEventStore } from "@/lib/tauri/event-store"
import { projectCanonicalFleetSession } from "./canonical-projection"
import { EMPTY_FLEET_SNAPSHOT, fleetStreamStore } from "./fleet-stream-store"
import type { FleetSession, FleetSnapshot } from "./types"

export function mergeFleetSnapshots(
  external: FleetSnapshot,
  canonical: ReadonlyMap<string, FleetSession>,
  generatedAt = external.generatedAt
): FleetSnapshot {
  const sessions = external.sessions.map((session) => ({
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

  const emit = () => listeners.forEach((listener) => listener())
  const refresh = () => {
    const latestCanonicalEvent = Math.max(
      0,
      ...Array.from(canonical.values(), (session) => session.lastEventAt)
    )
    snapshot = mergeFleetSnapshots(fleetStreamStore.getSnapshot(), canonical, latestCanonicalEvent)
    emit()
  }
  const onEnvelope = (raw: AgentEventEnvelope) => {
    const envelope = redactAgentEventEnvelope(raw)
    canonical.set(
      envelope.sessionId,
      projectCanonicalFleetSession(canonical.get(envelope.sessionId), envelope)
    )
    void appendCanonicalEnvelopes(envelope.runId, [envelope])
    refresh()
  }

  const attach = () => {
    const currentGeneration = generation
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
