"use client"

/**
 * Renderer-side dispatcher for the agent's `terminal_dock_*` MCP tool
 * calls. Wave 1 of the dock↔agent unification: the agent's MCP tool no
 * longer spawns its own `child_process` siblings of the user's dock —
 * the four synthetic `terminal_dock_*` tools are manifested by
 * `lib/plugin/bridge/sidecar-tools-bridge.ts:buildTerminalDockManifestEntries`,
 * the sidecar proxies them through the existing `plugin_tool_exec`
 * stream (`sidecar/builtin-tools/plugin-tools.mjs`), and the renderer's
 * `lib/claude/plugin-tool-ipc.ts:handlePluginToolExec` recognises the
 * `terminal_dock_` prefix and routes here.
 *
 * Result: the bytes the agent "types" land in the user's visible PTY.
 * One shell, one cwd, one history. No more parallel terminal universes.
 *
 * Every action re-reads `settings.terminal.exposeDockToAgents` so a
 * mid-session toggle off immediately denies the next call — defence in
 * depth even though the manifest wouldn't have been emitted in the
 * first place when the gate is off.
 */

import { requestAgentTrust } from "./agent-trust"
import { runInDockTab } from "./run-in-dock"
import { spawnFromDock } from "./spawn-orchestrator"
import { useSettingsStore } from "@/stores/settings"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import type { TerminalDockAction } from "@/lib/plugin/bridge/terminal-dock-schemas"

import { getLiveSession } from "./session-registry"

export interface RunTerminalDockActionInput {
  /** One of "spawn" | "write" | "read_recent" | "wait_for_exit". */
  action: TerminalDockAction
  /** Tool arguments as serialised by the model. Validated per action. */
  args: Record<string, unknown>
  /** Chat session id passed through `plugin_tool_exec` — scopes the consent grant. */
  chatSessionId: string
}

/** Discriminated result the sidecar surfaces back to the model as JSON text. */
export type DockActionResult =
  | { ok: true; sessionId: string; exitCode?: number | null; output?: string }
  | { ok: true; records: Array<{ cmd: string; exitCode: number | null; endedAt: number }> }
  | { ok: false; reason: string }

const DEFAULT_SPAWN_ROWS = 24
const DEFAULT_SPAWN_COLS = 80

/**
 * Dispatch table for the four `terminal_dock_*` actions. Each branch is
 * a thin wrapper over an existing renderer helper:
 *
 *   spawn         → spawnFromDock (+ runInDockTab when a command is given)
 *   write         → runInDockTab (handles consent + write + wait_for_exit)
 *   read_recent   → reads the lastCommands ring buffer in terminal-store
 *   wait_for_exit → installs an onIntegration listener and resolves on
 *                   the next command_end OSC 633 D event
 */
export async function runTerminalDockAction(
  input: RunTerminalDockActionInput
): Promise<DockActionResult> {
  // Defence-in-depth gate. The manifest wouldn't have been emitted
  // when this is false, but the model could still emit a stale
  // tool_use after the user flipped it off mid-conversation.
  if (!readExposeDockToAgents()) {
    return { ok: false, reason: "agent terminal access is disabled" }
  }

  switch (input.action) {
    case "spawn":
      return runSpawn(input)
    case "write":
      return runWrite(input)
    case "read_recent":
      return runReadRecent(input)
    case "wait_for_exit":
      return runWaitForExit(input)
    default:
      return { ok: false, reason: `unknown action: ${input.action as string}` }
  }
}

function readExposeDockToAgents(): boolean {
  try {
    return useSettingsStore.getState().settings?.terminal?.exposeDockToAgents === true
  } catch {
    // Store not initialised (very early renderer boot) — fail closed.
    return false
  }
}

function readRunInDockTimeoutMs(): number {
  try {
    const sec = useSettingsStore.getState().settings?.terminal?.runInDockTimeoutSec
    if (typeof sec === "number" && Number.isFinite(sec) && sec >= 5 && sec <= 600) {
      return sec * 1000
    }
  } catch {
    /* fall through */
  }
  return 60_000
}

function pickTimeoutMs(args: Record<string, unknown>): number {
  const raw = args.timeoutSec
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 5 && raw <= 600) {
    return raw * 1000
  }
  return readRunInDockTimeoutMs()
}

async function runSpawn(input: RunTerminalDockActionInput): Promise<DockActionResult> {
  const { args, chatSessionId } = input
  const command = typeof args.command === "string" ? args.command : null
  const cwd = typeof args.cwd === "string" ? args.cwd : undefined
  const shell = typeof args.shell === "string" && args.shell.length > 0 ? args.shell : ""
  const projectId = typeof args.projectId === "string" ? args.projectId : undefined

  if (command) {
    // Spawn + run + wait — all handled by the existing helper.
    const outcome = await runInDockTab({
      chatSessionId,
      newTab: {
        req: {
          rows: DEFAULT_SPAWN_ROWS,
          cols: DEFAULT_SPAWN_COLS,
          shell,
          cwd,
          projectId,
        },
      },
      command,
      timeoutMs: pickTimeoutMs(args),
    })
    return mapRunInDockOutcome(outcome)
  }

  // Bare spawn — just open a tab. No consent needed because nothing is
  // being written. The session is registered to the agent via the
  // `agentSpawner` field so the dock's agent-only filter picks it up.
  const store = useTerminalStore.getState()
  const result = await spawnFromDock({
    req: {
      rows: DEFAULT_SPAWN_ROWS,
      cols: DEFAULT_SPAWN_COLS,
      shell,
      cwd,
      projectId,
      enableShellIntegration: true,
    },
    store,
    agentSpawner: chatSessionId,
  })
  if (result.kind === "spawned") {
    return { ok: true, sessionId: result.sessionId }
  }
  if (result.kind === "denied") {
    return { ok: false, reason: "plugin policy denied terminal spawn" }
  }
  return { ok: false, reason: result.message ?? "spawn failed" }
}

async function runWrite(input: RunTerminalDockActionInput): Promise<DockActionResult> {
  const { args, chatSessionId } = input
  const tabId = typeof args.tabId === "string" ? args.tabId : null
  const command = typeof args.command === "string" ? args.command : null
  if (!tabId) return { ok: false, reason: "missing tabId" }
  if (!command) return { ok: false, reason: "missing command" }

  const outcome = await runInDockTab({
    chatSessionId,
    tabId,
    command,
    timeoutMs: pickTimeoutMs(args),
  })
  return mapRunInDockOutcome(outcome)
}

function runReadRecent(input: RunTerminalDockActionInput): DockActionResult {
  const { args } = input
  const tabId = typeof args.tabId === "string" ? args.tabId : null
  if (!tabId) return { ok: false, reason: "missing tabId" }
  const lineLimit =
    typeof args.lineLimit === "number" && args.lineLimit >= 1 && args.lineLimit <= 50
      ? Math.floor(args.lineLimit)
      : 10
  const row = useTerminalStore.getState().sessions[tabId]
  if (!row) return { ok: false, reason: `unknown session: ${tabId}` }
  const records = row.lastCommands.slice(-lineLimit).map((c) => ({
    cmd: c.cmd,
    exitCode: c.exitCode,
    endedAt: c.endedAt,
  }))
  return { ok: true, records }
}

async function runWaitForExit(input: RunTerminalDockActionInput): Promise<DockActionResult> {
  const { args, chatSessionId } = input
  const tabId = typeof args.tabId === "string" ? args.tabId : null
  if (!tabId) return { ok: false, reason: "missing tabId" }

  const session = getLiveSession(tabId)
  if (!session) return { ok: false, reason: `session ${tabId} is not live` }

  const row = useTerminalStore.getState().sessions[tabId]
  // Consent — same scope as runInDockTab so an existing grant carries
  // through. We don't actually write anything here, but we want the
  // user to have approved this tab for this chat session.
  const trusted = await requestAgentTrust({
    chatSessionId,
    tabId,
    tabTitle: row?.customTitle ?? row?.title ?? tabId,
    commandPreview: "(wait_for_exit)",
  })
  if (!trusted) return { ok: false, reason: "user denied terminal access" }

  const timeoutMs = pickTimeoutMs(args)

  return new Promise<DockActionResult>((resolve) => {
    let off: (() => void) | null = null
    const timer = setTimeout(() => {
      try {
        off?.()
      } catch {
        /* noop */
      }
      resolve({ ok: false, reason: "timeout" })
    }, timeoutMs)
    off = session.onIntegration((event) => {
      if (event.kind !== "command_end") return
      clearTimeout(timer)
      try {
        off?.()
      } catch {
        /* noop */
      }
      void Promise.resolve().then(() => {
        const updated = useTerminalStore.getState().sessions[tabId]
        const last = updated?.lastCommands?.[updated.lastCommands.length - 1]
        resolve({
          ok: true,
          sessionId: tabId,
          exitCode: event.exit_code ?? null,
          output: last?.cmd ?? "",
        })
      })
    })
  })
}

function mapRunInDockOutcome(outcome: Awaited<ReturnType<typeof runInDockTab>>): DockActionResult {
  switch (outcome.kind) {
    case "ok":
      return {
        ok: true,
        sessionId: outcome.sessionId,
        exitCode: outcome.exitCode,
        output: outcome.output,
      }
    case "denied":
      return { ok: false, reason: "user denied terminal access" }
    case "timeout":
      return { ok: false, reason: `timeout (session ${outcome.sessionId})` }
    case "error":
      return { ok: false, reason: outcome.message }
  }
}
