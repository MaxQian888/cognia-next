/**
 * Run-scoped remote browser sessions.
 *
 * Modelled on `lib/terminal/headless-session-registry.ts`, which the
 * orchestrator already tears down in `releaseRunResources`. A browser family
 * is inherently multi-step over one page (open, snapshot, act, waitFor), so
 * the session has to outlive a step and die with the run.
 *
 * Deliberately NOT the remote-step broker. That is one-shot request/response
 * with no session affinity, and its only responder is a five-entry map of
 * Capacitor facades on a phone, which has no browser runtime to offer.
 */

import { loggers } from "@cognia/logging"
import type { BrowserEngine } from "@/lib/browser/agent-engine"

export interface RunBrowserSession {
  /** The remote runtime's session id, for `browser_session_close`. */
  browserSessionId: string
  engine: BrowserEngine
}

const byRun = new Map<string, RunBrowserSession>()

export function getRunBrowserSession(runId: string): RunBrowserSession | undefined {
  return byRun.get(runId)
}

export function registerRunBrowserSession(runId: string, session: RunBrowserSession): void {
  byRun.set(runId, session)
}

/**
 * Close the run's browser session. Idempotent, and best-effort: a session the
 * runtime already reaped must not fail a run that has otherwise finished.
 */
export async function closeRunBrowserSessions(runId: string): Promise<void> {
  const session = byRun.get(runId)
  if (!session) return
  byRun.delete(runId)
  try {
    const { transport } = await import("@/lib/tauri")
    await transport.call("browser_session_close", { browserSessionId: session.browserSessionId })
  } catch (error) {
    loggers.network.warn("workflow browser session close failed", {
      runId,
      error: String(error),
    })
  }
}

/** Test-only. */
export function __resetRunBrowserSessionsForTesting(): void {
  byRun.clear()
}
