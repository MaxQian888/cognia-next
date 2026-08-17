"use client"

/**
 * Process-wide registry of live `TerminalSession` instances, keyed by id.
 *
 * Why this exists: the dock's `terminal-store` (zustand + persist) holds
 * UI-facing rows, which must stay JSON-serialisable. The runtime
 * `TerminalSession` instance — a class with event channels, generic
 * onData listeners, and an internal Channel — can't live there. This
 * tiny module bridges the two: callers register the live instance
 * after spawn and look it up by id from React components.
 *
 * Lifecycle: callers register on spawn, unregister on exit / kill.
 * Window reload tears the renderer registry down, but the durable host keeps
 * sessions and replay alive so rehydration can register fresh client handles.
 */

import type { BaseTerminalSession } from "./base-session"

const sessions = new Map<string, BaseTerminalSession>()
const listeners = new Set<() => void>()
/** Per-session `onInfo` unsubscribers, so a replaced/removed handle stops notifying. */
const infoSubscriptions = new Map<string, () => void>()

export function registerLiveSession(session: BaseTerminalSession): void {
  infoSubscriptions.get(session.id)?.()
  sessions.set(session.id, session)
  // A host snapshot (roster / lease change, ADR-0133) mutates `session.info`
  // in place; re-broadcast so `useSyncExternalStore` consumers of the
  // registry (chip, share dialog) re-read it without polling.
  const off = typeof session.onInfo === "function" ? session.onInfo(() => notify()) : undefined
  if (off) infoSubscriptions.set(session.id, off)
  else infoSubscriptions.delete(session.id)
  notify()
}

export function unregisterLiveSession(id: string): boolean {
  infoSubscriptions.get(id)?.()
  infoSubscriptions.delete(id)
  const removed = sessions.delete(id)
  if (removed) notify()
  return removed
}

export function getLiveSession(id: string): BaseTerminalSession | undefined {
  return sessions.get(id)
}

export function listLiveSessions(): BaseTerminalSession[] {
  return Array.from(sessions.values())
}

export function subscribeLiveSessions(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (err) {
      console.warn("session-registry: listener threw:", err)
    }
  }
}

/** Test-only — drop accumulated state so suites are hermetic. */
export function __clearLiveSessionsForTesting(): void {
  for (const off of infoSubscriptions.values()) off()
  infoSubscriptions.clear()
  sessions.clear()
  listeners.clear()
}
