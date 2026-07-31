"use client"

/**
 * Launch a `cognia` plugin-author CLI command in a fresh terminal dock tab.
 *
 * This is the user-initiated counterpart to `run-in-dock.ts`: a developer
 * clicks "Build" / "Dev" in the Plugin DevTools launcher, so there is no
 * agent-trust gate and no `agentSpawner` — the tab is an ordinary user tab,
 * visible and interactive in the dock. We spawn + write the command and
 * return immediately rather than waiting for `command_end`, because some
 * commands (`cognia plugin dev`) are long-running interactive watch loops.
 *
 * PATH discovery of the `cognia` binary itself is handled in Rust at spawn
 * time (`terminal::commands::build_cli_path_injection` weaves the
 * downloaded / dev / `~/.cargo/bin` locations into the child PATH).
 */

import { spawnFromDock, type TerminalStoreLike } from "./spawn-orchestrator"
import { getLiveSession } from "./session-registry"
import { resolveDefaultShell } from "./shell-detect"

export interface LaunchCogniaInput {
  /**
   * Argv string appended after the `cognia` binary, e.g.
   * `"plugin build"` or `"plugin install /path/to/bundle.zip"`. Shell
   * quoting is the caller's responsibility (paths with spaces should be
   * quoted before they reach here).
   */
  command: string
  /** Working directory the command runs in (the plugin project dir). */
  cwd: string
  /** Shell to spawn. Defaults to the platform/setting default shell. */
  shell?: string
  /** Live terminal store. Injected for tests; defaults to the real store. */
  store: TerminalStoreLike & {
    setPanelOpen: (open: boolean) => void
  }
  /** Test seam — swap `spawnFromDock`. */
  spawn?: typeof spawnFromDock
  /** Test seam — swap the live-session lookup. */
  lookup?: typeof getLiveSession
}

export type LaunchCogniaOutcome =
  | { kind: "launched"; sessionId: string }
  | { kind: "denied"; reason?: string }
  | { kind: "error"; message: string }

interface LaunchDockCommandInput {
  cwd: string
  shell?: string
  store: LaunchCogniaInput["store"]
  spawn?: typeof spawnFromDock
  lookup?: typeof getLiveSession
}

async function launchDockCommand(
  input: LaunchDockCommandInput,
  command: string
): Promise<LaunchCogniaOutcome> {
  const spawn = input.spawn ?? spawnFromDock
  const lookup = input.lookup ?? getLiveSession
  const shell = input.shell ?? resolveDefaultShell({})

  // Surface the dock so the spawned tab is visible while the command runs.
  input.store.setPanelOpen(true)

  const outcome = await spawn({
    req: {
      shell,
      cwd: input.cwd,
      rows: 24,
      cols: 80,
      enableShellIntegration: true,
    },
    store: input.store,
  })

  if (outcome.kind !== "spawned") {
    return outcome.kind === "denied"
      ? { kind: "denied", reason: outcome.reason }
      : {
          kind: "error",
          message: outcome.kind === "error" ? outcome.message : "spawn failed",
        }
  }

  const session = lookup(outcome.sessionId)
  if (!session) {
    return { kind: "error", message: `session ${outcome.sessionId} is not live` }
  }

  // Trailing CR submits the line; OSC 633 markers capture the exit code into
  // the store's `lastCommands` ring.
  await session.write(`${command}\r`)
  return { kind: "launched", sessionId: outcome.sessionId }
}

export async function launchCognia(input: LaunchCogniaInput): Promise<LaunchCogniaOutcome> {
  return launchDockCommand(input, `cognia ${input.command}`)
}

export interface LaunchCogniaAgentInput extends LaunchDockCommandInput {
  /** Desktop session whose confined handoff drop should be resumed. */
  handoffSessionId: string
}

/** Launch the standalone chat TUI against a desktop-authored handoff drop. */
export async function launchCogniaAgent(
  input: LaunchCogniaAgentInput
): Promise<LaunchCogniaOutcome> {
  // The command is submitted through the user's shell. Session ids are opaque
  // application identifiers, so reject shell metacharacters instead of trying
  // to quote across zsh/bash/fish/PowerShell/cmd syntaxes.
  if (!/^[A-Za-z0-9._-]+$/.test(input.handoffSessionId) || input.handoffSessionId.length > 256) {
    return { kind: "error", message: "invalid handoff session id" }
  }
  return launchDockCommand(input, `cognia-agent resume ${input.handoffSessionId}`)
}
