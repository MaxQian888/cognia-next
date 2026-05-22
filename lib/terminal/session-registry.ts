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
 * Window reload tears the module down; sessions die with the Rust
 * process via `PtySession::Drop`. No persistence (replay is out of v1
 * scope per the plan).
 */

import type { TerminalSession } from "./session"

const sessions = new Map<string, TerminalSession>()
const listeners = new Set<() => void>()

export function registerLiveSession(session: TerminalSession): void {
  sessions.set(session.id, session)
  notify()
}

export function unregisterLiveSession(id: string): boolean {
  const removed = sessions.delete(id)
  if (removed) notify()
  return removed
}

export function getLiveSession(id: string): TerminalSession | undefined {
  return sessions.get(id)
}

export function listLiveSessions(): TerminalSession[] {
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
  sessions.clear()
  listeners.clear()
}
