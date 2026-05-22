"use client"

/**
 * Bridge from a chat surface to a dock tab: "run this command in the
 * selected tab on my behalf".
 *
 * Composes existing pieces — no new event pipelines:
 *   1. `requestAgentTrust` opens the consent overlay (or skips if a
 *      session grant already exists).
 *   2. `getLiveSession(tabId).write(cmd + "\r")` pipes the command into
 *      the PTY.
 *   3. We listen on the next `command_end` integration event for the
 *      exit code — `spawn-orchestrator` has already attached the OSC 633
 *      → store wiring, so we just observe `session.onIntegration`.
 *   4. The captured command and its exit code surface in
 *      `useTerminalStore.sessions[tabId].lastCommands` (Wave 1 store
 *      capture), so callers can read the freshly-pushed row to get the
 *      finalized record.
 *
 * Timeout default: 60 seconds. Long-running commands can pass a higher
 * limit — but the goal of this API is "send a command and wait for its
 * exit"; if the user expects a daemon, they should not use it.
 */

import { requestAgentTrust } from "./agent-trust"
import { getLiveSession } from "./session-registry"
import { spawnFromDock } from "./spawn-orchestrator"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { SpawnRequest } from "./types"

export interface RunInDockInput {
  /** Identifier of the chat session driving this — scopes the trust grant. */
  chatSessionId: string
  /** Existing tab to run in. Mutually exclusive with `newTab`. */
  tabId?: string
  /** When true, spawn a new tab first, then run. */
  newTab?: { req: Pick<SpawnRequest, "shell" | "cwd" | "env" | "projectId" | "rows" | "cols"> }
  command: string
  /** Max wait time for command_end in ms. Default 60_000. */
  timeoutMs?: number
}

export type RunInDockOutcome =
  | { kind: "ok"; sessionId: string; exitCode: number | null; output: string }
  | { kind: "denied" }
  | { kind: "timeout"; sessionId: string }
  | { kind: "error"; message: string }

const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Resolve the effective wait-for-exit timeout. Per-call `input.timeoutMs`
 * wins; otherwise read the user setting `terminal.runInDockTimeoutSec`
 * (clamped to [5, 600] seconds); otherwise fall back to 60 s.
 *
 * Reading at call time (not import time) means a settings change takes
 * effect on the very next invocation without restarting the renderer.
 */
function resolveTimeoutMs(perCallMs: number | undefined): number {
  if (typeof perCallMs === "number" && Number.isFinite(perCallMs) && perCallMs > 0) {
    return perCallMs
  }
  try {
    const sec = useSettingsStore.getState().settings?.terminal?.runInDockTimeoutSec
    if (typeof sec === "number" && Number.isFinite(sec) && sec >= 5 && sec <= 600) {
      return sec * 1000
    }
  } catch {
    /* settings store not initialised — fall through */
  }
  return DEFAULT_TIMEOUT_MS
}

export async function runInDockTab(input: RunInDockInput): Promise<RunInDockOutcome> {
  const store = useTerminalStore.getState()
  let sessionId = input.tabId ?? null

  // 1. Spawn if requested.
  if (!sessionId) {
    if (!input.newTab) return { kind: "error", message: "no tabId and no newTab spec" }
    const outcome = await spawnFromDock({
      req: {
        rows: input.newTab.req.rows ?? 24,
        cols: input.newTab.req.cols ?? 80,
        shell: input.newTab.req.shell,
        cwd: input.newTab.req.cwd,
        env: input.newTab.req.env,
        projectId: input.newTab.req.projectId,
        enableShellIntegration: true,
      },
      store,
      agentSpawner: input.chatSessionId,
    })
    if (outcome.kind !== "spawned") {
      return outcome.kind === "denied"
        ? { kind: "denied" }
        : { kind: "error", message: outcome.kind === "error" ? outcome.message : "spawn failed" }
    }
    sessionId = outcome.sessionId
  }
  if (!sessionId) return { kind: "error", message: "no session id resolved" }

  const row = store.sessions[sessionId]
  if (!row) return { kind: "error", message: `unknown session: ${sessionId}` }

  // 2. Consent gate. The row's `agentTrusted` flag mirrors the broker's
  // grant — but the broker is the source of truth (so cross-reload state
  // stays consistent). Calling request again is cheap when a grant is
  // already cached.
  const trusted = await requestAgentTrust({
    chatSessionId: input.chatSessionId,
    tabId: sessionId,
    tabTitle: row.customTitle ?? row.title,
    commandPreview: input.command,
  })
  if (!trusted) return { kind: "denied" }
  store.setAgentTrusted(sessionId, true)

  // 3. Get the live session and arm command_end listener BEFORE writing.
  const session = getLiveSession(sessionId)
  if (!session) return { kind: "error", message: `session ${sessionId} is not live` }

  const timeoutMs = resolveTimeoutMs(input.timeoutMs)
  const result = await new Promise<RunInDockOutcome>((resolve) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      try {
        off?.()
      } catch {
        /* noop */
      }
      resolve({ kind: "timeout", sessionId: sessionId! })
    }, timeoutMs)
    off = session.onIntegration((event) => {
      if (event.kind !== "command_end") return
      clearTimeout(timer)
      try {
        off?.()
      } catch {
        /* noop */
      }
      // Wait one microtask for spawn-orchestrator's pushCommand to land.
      void Promise.resolve().then(() => {
        const updated = useTerminalStore.getState().sessions[sessionId!]
        const last = updated?.lastCommands?.[updated.lastCommands.length - 1]
        resolve({
          kind: "ok",
          sessionId: sessionId!,
          exitCode: event.exit_code ?? null,
          output: last?.cmd ?? "",
        })
      })
    })
    // 4. Pipe the command. Trailing CR triggers shell submit (and OSC 633
    // C, then D).
    void session.write(input.command + "\r")
  })

  return result
}
