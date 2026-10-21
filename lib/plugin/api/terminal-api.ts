/**
 * Plugin Terminal API (`ctx.terminal`) — imperative access to the
 * integrated terminal dock for plugins (build runners, dev-server
 * launchers, REPL bridges).
 *
 * Until now the dock was only reachable by the chat agent via the
 * synthetic `terminal_dock_*` MCP tools (`lib/terminal/dock-tool-handler.ts`),
 * gated by chat-session agent-trust. The `terminal:spawn|write|kill`
 * permissions existed but had no imperative surface. This wraps the same
 * dock primitives (`spawnFromDock` / `killFromDock` / the live
 * `TerminalSession`) so plugins can drive a real PTY in the user's dock.
 *
 * SAFETY:
 *  - Each spawned session is tagged with the plugin id (`extensionId`), so
 *    the dock shows it as plugin-owned and the store scopes visibility.
 *  - `write` / `kill` / `onData` / `readRecent` are **ownership-checked**:
 *    a plugin can only touch sessions IT spawned — never the user's tabs
 *    or another plugin's. This is the critical guard that makes a raw
 *    terminal surface safe to expose.
 *  - Permissions: `terminal:spawn` (create/list/read), `terminal:write`
 *    (pipe stdin), `terminal:kill` (terminate). All three are `DANGEROUS`.
 *  - Desktop/LAN-only — `spawnFromDock` returns an error when no PTY
 *    transport is available (plain browser).
 */

import { spawnFromDock, killFromDock } from "@/lib/terminal/spawn-orchestrator"
import { getLiveSession } from "@/lib/terminal/session-registry"
import { useTerminalStore } from "@/stores/terminal/terminal-store"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import {
  buildScriptSpawnRequest,
  detectScriptType as detectScriptTypeImpl,
} from "@/lib/terminal/script-runner"
import {
  adaptPluginCompletionProvider,
  registerPluginCompletionProvider,
} from "@/lib/plugin/bridge/terminal-completion-bridge"
import { registerPluginCommandRules } from "@/lib/plugin/registries/command-safety-registry"
import { classifyCommand as classifyCommandImpl } from "@/lib/claude/permissions/command-safety"
import type { ToolRules } from "@/lib/claude/permissions/ruleset"
import type { SpawnRequest } from "@/lib/terminal/types"
import type { PluginTerminalAPI } from "@cognia/plugin-contract/lib/plugin/api/terminal-api"
export type {
  PluginCommandClassification,
  PluginCommandRule,
  PluginRunScriptOptions,
  PluginTerminalAPI,
  PluginTerminalCommandRecord,
  PluginTerminalInfo,
  PluginTerminalSpawnOptions,
} from "@cognia/plugin-contract/lib/plugin/api/terminal-api"

const DEFAULT_ROWS = 24
const DEFAULT_COLS = 80

/** Thrown when a plugin touches a session it doesn't own / that's gone. */
export class TerminalAccessError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TerminalAccessError"
  }
}

/**
 * Create the Terminal API for a plugin. `spawn`/`list`/`readRecent`/`onData`
 * need `terminal:spawn`; `write` needs `terminal:write`; `kill` needs
 * `terminal:kill`. Mutating methods additionally enforce ownership.
 */
export function createTerminalAPI(pluginId: string): PluginTerminalAPI {
  /** Throw unless `id` is a live session this plugin spawned. */
  function assertOwned(id: string): void {
    const row = useTerminalStore.getState().sessions[id]
    if (!row) throw new TerminalAccessError(`ctx.terminal: unknown session "${id}"`)
    if (row.extensionId !== pluginId) {
      throw new TerminalAccessError(
        `ctx.terminal: session "${id}" is not owned by this plugin — you can only touch sessions you spawned.`
      )
    }
  }

  /** Spawn `req` (always tagged to this plugin) and normalise the outcome. */
  async function doSpawn(req: SpawnRequest, label: string): Promise<{ id: string; shell: string }> {
    const outcome = await spawnFromDock({
      // Tag ownership so the dock + this API scope the session to us.
      req: { ...req, extensionId: pluginId },
      store: useTerminalStore.getState(),
    })
    if (outcome.kind === "spawned") {
      return { id: outcome.sessionId, shell: outcome.shell }
    }
    if (outcome.kind === "denied") {
      throw new TerminalAccessError(
        `ctx.terminal.${label} denied by policy${outcome.reason ? `: ${outcome.reason}` : ""}`
      )
    }
    throw new Error(`ctx.terminal.${label} failed: ${outcome.message}`)
  }

  const api: PluginTerminalAPI = {
    spawn: async (options = {}) =>
      doSpawn(
        {
          shell: options.shell ?? "",
          cwd: options.cwd,
          env: options.env,
          rows: options.rows ?? DEFAULT_ROWS,
          cols: options.cols ?? DEFAULT_COLS,
          projectId: options.projectId,
          enableShellIntegration: options.enableShellIntegration ?? true,
        },
        "spawn"
      ),

    runScript: async (scriptPath, options = {}) => {
      const req = buildScriptSpawnRequest(scriptPath, {
        interpreter: options.interpreter,
        cwd: options.cwd,
        args: options.args,
        env: options.env,
        rows: options.rows ?? DEFAULT_ROWS,
        cols: options.cols ?? DEFAULT_COLS,
        projectId: options.projectId,
        shebang: options.shebang,
      })
      return doSpawn(req, "runScript")
    },

    detectScriptType: (scriptPath, shebang) => detectScriptTypeImpl(scriptPath, { shebang }),

    write: async (id, data) => {
      assertOwned(id)
      const session = getLiveSession(id)
      if (!session) throw new TerminalAccessError(`ctx.terminal: session "${id}" is not live`)
      await session.write(data)
    },

    kill: async (id) => {
      assertOwned(id)
      await killFromDock(id, useTerminalStore.getState())
    },

    onData: (id, handler) => {
      assertOwned(id)
      const session = getLiveSession(id)
      if (!session) throw new TerminalAccessError(`ctx.terminal: session "${id}" is not live`)
      return session.onData(handler)
    },

    readRecent: (id, lineLimit = 10) => {
      assertOwned(id)
      const row = useTerminalStore.getState().sessions[id]
      const limit = Math.max(1, Math.min(50, Math.floor(lineLimit)))
      return row.lastCommands.slice(-limit).map((c) => ({
        cmd: c.cmd,
        exitCode: c.exitCode,
        endedAt: c.endedAt,
      }))
    },

    list: () => {
      const sessions = useTerminalStore.getState().sessions
      return Object.values(sessions)
        .filter((row) => row.extensionId === pluginId)
        .map((row) => ({
          id: row.id,
          shell: row.shell,
          cwd: row.cwd,
          status: row.status,
        }))
    },

    registerCompletionProvider: (provider) => {
      const host = adaptPluginCompletionProvider(
        pluginId,
        { id: provider.id, label: provider.label, priority: provider.priority },
        provider
      )
      return registerPluginCompletionProvider(pluginId, host)
    },

    registerCommandSafetyRule: (rules) => {
      const list = Array.isArray(rules) ? rules : [rules]
      const map: ToolRules = {}
      for (const r of list) {
        if (
          r &&
          typeof r.pattern === "string" &&
          r.pattern.length > 0 &&
          (r.verdict === "allow" || r.verdict === "ask" || r.verdict === "deny")
        ) {
          map[r.pattern] = r.verdict
        }
      }
      if (Object.keys(map).length === 0) return () => {}
      return registerPluginCommandRules(pluginId, map)
    },

    classifyCommand: (command) => {
      const c = classifyCommandImpl(String(command ?? ""))
      return { verdict: c.verdict, reason: c.reason, matched: c.matched }
    },
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      spawn: "terminal:spawn",
      runScript: "terminal:spawn",
      detectScriptType: "terminal:spawn",
      list: "terminal:spawn",
      readRecent: "terminal:spawn",
      onData: "terminal:spawn",
      write: "terminal:write",
      kill: "terminal:kill",
      registerCompletionProvider: "terminal:completion",
      registerCommandSafetyRule: "terminal:safety",
      classifyCommand: "terminal:safety",
    },
    {
      // These are synchronous queries / a subscription / a pure helper — they
      // return non-Promises and (for the owned-session ones) throw ownership
      // errors synchronously. They share `terminal:spawn` with the actual
      // spawn action but must not route through the async consent overlay.
      consentExempt: ["detectScriptType", "list", "readRecent", "onData", "classifyCommand"],
    }
  )
}
