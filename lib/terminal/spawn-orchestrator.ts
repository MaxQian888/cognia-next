"use client"

/**
 * Spawn orchestrator — single entry point the dock's "+ New" affordance
 * (and any other user-initiated terminal flow) calls to:
 *
 *   1. Resolve the effective shell + cwd from project / settings.
 *   2. Run the pre-spawn veto hook
 *      (`dispatchTerminalWillSpawn` — plugins can deny or mutate).
 *   3. Spawn the `TerminalSession` via the Tauri command.
 *   4. Register the live instance in `session-registry` + UI row in
 *      `terminal-store`.
 *   5. Wire session events to store mutators (status, cwd, exit).
 *   6. Fire `dispatchTerminalLifecycle("spawned" / "exited")` for plugin
 *      audit listeners.
 *
 * The orchestrator is the single seam where plugin policy meets the
 * Rust session boundary, so audit / veto stay in one place rather than
 * scattered through component callbacks.
 */

import { getPluginEventHooks } from "@/lib/plugin"

import type { BaseTerminalSession } from "./base-session"
import { selectTerminalTransport } from "./pick-transport"
import { TerminalSession } from "./session"
import { registerLiveSession, unregisterLiveSession } from "./session-registry"
import { RemoteTerminalSession } from "./transport-ws"
import type { SpawnRequest } from "./types"

export type SpawnOutcome =
  | { kind: "spawned"; sessionId: string; shell: string }
  | { kind: "denied"; reason?: string }
  | { kind: "error"; message: string }

export interface TerminalStoreLike {
  registerSession(
    info: {
      id: string
      projectId: string | null
      extensionId: string | null
      origin: "local" | "remote"
      shell: string
    },
    opts?: { title?: string; agentSpawner?: string }
  ): void
  removeSession(id: string): void
  setSessionStatus(id: string, status: "idle" | "running" | "exited"): void
  setSessionExit(id: string, exitCode: number | null): void
  setSessionCwd(id: string, cwd: string): void
  pushPrompt(id: string, startMs: number): void
  closePrompt(id: string, endMs: number): void
  pushCommand(id: string, record: { cmd: string; exitCode: number | null; endedAt: number }): void
  /** Used by `restartFromDock` to read the previous row's shell/cwd for respawn. */
  sessions: Record<
    string,
    {
      id: string
      shell: string
      cwd: string | null
      projectId: string | null
      extensionId: string | null
      agentSpawner: string | null
    }
  >
}

export interface SpawnFromDockInput {
  /** Pre-resolved spawn request — caller already did shell-detect + project override. */
  req: SpawnRequest
  /** Live store (`useTerminalStore.getState()`); injected so tests can stub. */
  store: TerminalStoreLike
  /** Test seam — swap the spawn function in unit tests. */
  spawn?: typeof TerminalSession.spawn
  /** Test seam — swap the plugin hook bus. */
  hooks?: ReturnType<typeof getPluginEventHooks>
  /**
   * Identity of the agent driving this spawn — set when the dock is
   * spawned via the `terminal_dock_*` MCP tool path
   * (`lib/terminal/dock-tool-handler.ts`). `terminal-store` scopes
   * agent visibility by this key so the agent only sees its own tabs.
   */
  agentSpawner?: string
}

/**
 * Resolve the active transport's spawn function. Tauri → in-process PTY
 * via `TerminalSession`; Capacitor → LAN-only WebSocket via
 * `RemoteTerminalSession`. Plain browser → null (caller should not
 * have invoked the orchestrator).
 */
function pickSpawnForTransport(): typeof TerminalSession.spawn | null {
  switch (selectTerminalTransport()) {
    case "tauri-channel":
      return TerminalSession.spawn.bind(TerminalSession)
    case "ws":
      // The two classes are structurally compatible from the orchestrator's
      // POV (`info`, `onIntegration`, `onExit`). A `bind` returns the same
      // signature; the cast is safe because `RemoteTerminalSession` shares
      // the public surface `spawn-orchestrator` consumes.
      return RemoteTerminalSession.spawn.bind(
        RemoteTerminalSession
      ) as unknown as typeof TerminalSession.spawn
    default:
      return null
  }
}

/**
 * Hard ceiling on how long the underlying `terminal_spawn` may take before
 * we give up and surface an error. The Rust spawn is near-instant; a stall
 * means something is wedged (the historical "stuck terminal blocks all new
 * terminals" bug). Resolving to an `error` outcome lets the caller show a
 * toast instead of hanging forever with no feedback.
 */
const SPAWN_TIMEOUT_MS = 15_000

/** Reject if `p` hasn't settled within `ms`. Clears its timer on settle. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * Spawn a terminal end-to-end. Returns:
 *   * `spawned` with the new session id on success,
 *   * `denied` when a plugin's `onTerminalWillSpawn` returned "deny",
 *   * `error` for any other failure (Tauri command threw, timed out, etc.).
 */
export async function spawnFromDock(input: SpawnFromDockInput): Promise<SpawnOutcome> {
  const hooks = input.hooks ?? getPluginEventHooks()
  const spawnFn = input.spawn ?? pickSpawnForTransport()
  if (!spawnFn) {
    return { kind: "error", message: "terminal transport unavailable" }
  }

  // 1. Veto / mutate gate.
  const { decision, req } = await hooks.dispatchTerminalWillSpawn(input.req)
  if (decision === "deny") {
    return { kind: "denied" }
  }

  // 2. Spawn. Bounded by a timeout so a wedged backend surfaces as an
  // error the dock can toast, never an indefinite silent hang.
  let session: TerminalSession
  try {
    session = await withTimeout(spawnFn(req as SpawnRequest), SPAWN_TIMEOUT_MS, "terminal spawn")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { kind: "error", message }
  }

  // 3. Register.
  registerLiveSession(session)
  input.store.registerSession(
    {
      id: session.info.id,
      projectId: session.info.projectId,
      extensionId: session.info.extensionId,
      origin: session.info.origin,
      shell: session.info.shell,
    },
    input.agentSpawner ? { agentSpawner: input.agentSpawner } : undefined
  )

  // 4-5. Command capture + integration/exit → store wiring. Shared with
  // the reload-reattach path (`lib/terminal/rehydrate.ts`).
  wireSessionToStore(session, input.store, hooks)

  // 6. Audit the spawn.
  hooks.dispatchTerminalLifecycle({
    kind: "spawned",
    sessionId: session.info.id,
    projectId: session.info.projectId,
    extensionId: session.info.extensionId,
  })

  return { kind: "spawned", sessionId: session.info.id, shell: session.info.shell }
}

/**
 * Wire a live session's events into the store: command capture (OSC 633
 * has no command-line frame, so we infer it from input bytes), integration
 * events → status / cwd / prompt / history, and exit → exit badge + audit
 * + registry cleanup. Shared by `spawnFromDock` and the reload-reattach
 * path so a reattached session behaves identically to a fresh one.
 */
export function wireSessionToStore(
  session: BaseTerminalSession,
  store: TerminalStoreLike,
  hooks: ReturnType<typeof getPluginEventHooks> = getPluginEventHooks()
): void {
  const capture = installCommandCapture(session)

  session.onIntegration((event) => {
    switch (event.kind) {
      case "prompt_start":
        store.pushPrompt(session.info.id, Date.now())
        break
      case "prompt_end":
        store.closePrompt(session.info.id, Date.now())
        break
      case "command_start":
        store.setSessionStatus(session.info.id, "running")
        capture.markCommandStart()
        break
      case "command_end": {
        store.setSessionStatus(session.info.id, "idle")
        // `takeCapturedCommand()` is consume-once — capture exactly once and
        // share between the in-memory ring and the durable history write.
        const cmd = capture.takeCapturedCommand()
        const endedAt = Date.now()
        store.pushCommand(session.info.id, {
          cmd,
          exitCode: event.exit_code,
          endedAt,
        })
        // exit_code here is the LAST command's exit, not the shell
        // process's exit; the row's exitCode is only set on session exit.
        persistCommandHistory(session, store, cmd, event.exit_code)
        fanOutCommandTrigger(session, store, cmd, event.exit_code, endedAt)
        break
      }
      case "cwd_changed":
        store.setSessionCwd(session.info.id, event.cwd)
        break
      default:
        break
    }
  })

  session.onExit((code) => {
    store.setSessionExit(session.info.id, code)
    // Best-effort cleanup so the registry doesn't leak handles for exited
    // shells. The store row stays so the user sees the "exited" badge until
    // they explicitly close the tab.
    unregisterLiveSession(session.info.id)
    hooks.dispatchTerminalLifecycle({
      kind: "exited",
      sessionId: session.info.id,
      projectId: session.info.projectId,
      extensionId: session.info.extensionId,
      exitCode: code,
    })
  })
}

/**
 * Persist one executed command to the durable history table (ADR-0039
 * phase 2). Fire-and-forget: history must never break the terminal, so
 * every failure path degrades to "not recorded".
 *
 * Gates, in order:
 *   1. non-blank command,
 *   2. `terminal.autocomplete.persistHistory` setting (default on),
 *   3. PII check — lines that look like secrets are never persisted.
 */
function persistCommandHistory(
  session: BaseTerminalSession,
  store: TerminalStoreLike,
  cmd: string,
  exitCode: number | null
): void {
  if (!cmd || cmd.trim().length === 0) return
  void (async () => {
    const [{ useSettingsStore }, { hasNoLeakingPii }, { recordTerminalHistory }] =
      await Promise.all([
        import("@/stores/settings/settings-store"),
        import("@cognia/redact"),
        import("@/lib/db/terminal-history"),
      ])
    const persist =
      useSettingsStore.getState().settings?.terminal?.autocomplete?.persistHistory !== false
    if (!persist) return
    if (!hasNoLeakingPii(cmd)) return
    await recordTerminalHistory({
      command: cmd,
      shell: session.info.shell,
      cwd: store.sessions[session.info.id]?.cwd ?? null,
      exitCode,
      sessionId: session.info.id,
      projectId: session.info.projectId,
    })
  })().catch(() => {
    // Best-effort — history persistence must never surface as a terminal error.
  })
}

/**
 * Fan a finished command out to `trigger.terminal.command` workflow
 * subscriptions. Fire-and-forget — the dispatcher itself applies the
 * user-spawned-only, blank-command, and PII gates
 * (`lib/terminal/command-trigger.ts`), and a workflow failure must never
 * surface as a terminal error.
 */
function fanOutCommandTrigger(
  session: BaseTerminalSession,
  store: TerminalStoreLike,
  cmd: string,
  exitCode: number | null,
  endedAt: number
): void {
  const row = store.sessions[session.info.id]
  void (async () => {
    const { dispatchTerminalCommandTriggers } = await import("./command-trigger")
    await dispatchTerminalCommandTriggers({
      sessionId: session.info.id,
      projectId: session.info.projectId,
      agentSpawner: row?.agentSpawner ?? null,
      command: cmd,
      exitCode,
      endedAt,
    })
  })().catch(() => {
    // Best-effort — trigger fan-out must never break the terminal.
  })
}

/**
 * Explicit kill — used by the dock's tab close button. Removes the
 * store row and the live registry entry, plus fires the lifecycle hook
 * for plugin audit consistency with the exited path.
 */
export async function killFromDock(
  sessionId: string,
  store: TerminalStoreLike,
  hooks: ReturnType<typeof getPluginEventHooks> = getPluginEventHooks()
): Promise<void> {
  const { getLiveSession } = await import("./session-registry")
  const session = getLiveSession(sessionId)
  if (session) {
    try {
      await session.kill()
    } catch (err) {
      console.warn(`spawn-orchestrator: kill threw for ${sessionId}:`, err)
    }
    hooks.dispatchTerminalLifecycle({
      kind: "killed",
      sessionId,
      projectId: session.info.projectId,
      extensionId: session.info.extensionId,
    })
  }
  unregisterLiveSession(sessionId)
  store.removeSession(sessionId)
}

/**
 * Restart a tab by killing the old session and spawning a fresh one
 * with the same shell + cwd + agent identity. Used by the right-click
 * "Restart" action and by exited-tab one-click revival.
 *
 * The previous row's `cwd` is preferred over the original spawn `cwd`
 * because it reflects where the user actually was when the shell died.
 */
export async function restartFromDock(input: {
  sessionId: string
  store: TerminalStoreLike
  /** Rows + cols come from the active xterm instance. */
  rows: number
  cols: number
  spawn?: typeof TerminalSession.spawn
  hooks?: ReturnType<typeof getPluginEventHooks>
}): Promise<SpawnOutcome> {
  const previous = input.store.sessions[input.sessionId]
  if (!previous) {
    return { kind: "error", message: `unknown session: ${input.sessionId}` }
  }
  const respawnReq: SpawnRequest = {
    shell: previous.shell,
    rows: input.rows,
    cols: input.cols,
    cwd: previous.cwd ?? undefined,
    projectId: previous.projectId ?? undefined,
    extensionId: previous.extensionId ?? undefined,
  }
  await killFromDock(input.sessionId, input.store, input.hooks)
  return spawnFromDock({
    req: respawnReq,
    store: input.store,
    spawn: input.spawn,
    hooks: input.hooks,
    agentSpawner: previous.agentSpawner ?? undefined,
  })
}

/**
 * Wrap `session.write` so we can keep a per-session capture of the most
 * recent fully-typed command line. Sufficient for the history panel
 * pre-OSC 633 `E`. Handles BS/DEL for in-line edits; arrow-key edits
 * remain approximate.
 */
function installCommandCapture(session: BaseTerminalSession): {
  markCommandStart: () => void
  takeCapturedCommand: () => string
} {
  let pendingLine = ""
  let lastCompletedLine = ""
  let armed = false

  const originalWrite = session.write.bind(session)
  ;(session as unknown as { write: BaseTerminalSession["write"] }).write = async (data) => {
    const str = typeof data === "string" ? data : new TextDecoder().decode(data)
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i)
      if (c === 0x0d || c === 0x0a) {
        // Newline → freeze pendingLine as the candidate command.
        lastCompletedLine = pendingLine
        pendingLine = ""
        continue
      }
      if (c === 0x7f || c === 0x08) {
        // BS / DEL — drop last char if any.
        if (pendingLine.length > 0) {
          pendingLine = pendingLine.slice(0, -1)
        }
        continue
      }
      if (c === 0x03) {
        // Ctrl+C — abort whatever was buffered.
        pendingLine = ""
        lastCompletedLine = ""
        continue
      }
      if (c === 0x1b) {
        // ESC — skip the ANSI sequence (`[<params><letter>` or `O<letter>`).
        if (i + 1 < str.length) {
          const next = str.charCodeAt(i + 1)
          if (next === 0x5b || next === 0x4f) {
            // CSI / SS3 — consume until a letter (0x40-0x7e).
            let j = i + 2
            while (j < str.length) {
              const cj = str.charCodeAt(j)
              if (cj >= 0x40 && cj <= 0x7e) {
                j++
                break
              }
              j++
            }
            i = j - 1
            continue
          }
          // Single-char ESC sequence (e.g. ESC + char) — skip one.
          i++
          continue
        }
        continue
      }
      if (c < 0x20) {
        // Other control chars — ignore.
        continue
      }
      pendingLine += str[i]
    }
    return originalWrite(data)
  }

  return {
    markCommandStart: () => {
      // OSC 633 C arrives after Enter; the line we captured up to here
      // is the command. Lock it in and arm the take-on-command-end.
      armed = true
    },
    takeCapturedCommand: () => {
      if (!armed) return ""
      armed = false
      const out = lastCompletedLine
      lastCompletedLine = ""
      return out
    },
  }
}
