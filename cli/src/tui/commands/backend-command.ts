/**
 * `/backend` — switch the agent that answers, without restarting the command.
 *
 *   /backend                 open the picker
 *   /backend builtin         Cognia's own sidecar agent
 *   /backend codex           host the Codex CLI
 *   /backend claude-code     host Claude Code
 *
 * The backend used to be chosen once at launch, before the TUI mounted, so
 * `config set agentBackend` needed a restart and the connect-failure page had
 * nowhere to fall back to. Switching is a real lifecycle event — the live
 * session is dropped and the new backend is connected through the same staged
 * startup flow — so the handler returns an effect rather than mutating config.
 *
 * Pure handler; the App owns the drop/connect.
 */
import { BUILTIN_EXECUTABLE_PRESET_IDS, getPresetConfig } from "@/lib/ai/agent/external/presets"

import type { CommandContext, CommandDescriptor, CommandEffect } from "./types"

/** The built-in sidecar's id, offered alongside the external presets. */
export const BUILTIN_BACKEND_ID = "builtin"

/** One-line description per backend, shown as the picker hint. */
const HINTS: Record<string, string> = {
  builtin: "Cognia's own agent (full feature set)",
  codex: "host the Codex CLI",
  "codex-acp": "host Codex explicitly over ACP",
  "codex-app-server": "host Codex over its app-server protocol",
  "claude-code": "host Claude Code over ACP",
}

/**
 * Presets whose provider credentials the CLI injects from
 * `~/.cognia/credentials.json`. Mirrors `externalAgentCredentialEnv` in
 * `agent/external-agent-session.ts` — kept as a local set rather than imported
 * so this pure command module doesn't pull the ~200KB external-agent stack into
 * the eagerly-loaded command registry. Any preset NOT here relies on the
 * agent's own prior `login`, which the hint says out loud.
 */
const CREDENTIAL_INJECTED = new Set(["codex", "codex-acp", "codex-app-server", "claude-code"])

/** The picker hint for a backend, marking the one currently in use, and warning
 * when the backend needs its own login. Every row gets some text — a blank hint
 * reads as a broken entry. */
export function backendHint(id: string, current: string): string {
  const blurb = HINTS[id] ?? "external agent"
  const needsLogin = id !== BUILTIN_BACKEND_ID && !CREDENTIAL_INJECTED.has(id)
  const base = needsLogin ? `${blurb} — log in with its own CLI first` : blurb
  return id === current ? `current — ${base}` : base
}

/**
 * Selectable backend ids: the built-in agent plus every executable preset that
 * actually spawns a process. A process-less preset (e.g. `opencode-remote`,
 * which connects to an already-running server) would die at the connect's
 * `command` stage, so offering it in the picker promises a backend that cannot
 * come up this way.
 */
export function backendChoices(
  presets: readonly string[] = BUILTIN_EXECUTABLE_PRESET_IDS
): string[] {
  const spawnable = presets.filter((id) => Boolean(getPresetConfig(id)?.process?.command))
  return [BUILTIN_BACKEND_ID, ...spawnable]
}

function handle(ctx: CommandContext): CommandEffect {
  const requested = ctx.args.trim().toLowerCase()
  const current = ctx.config.agentBackend ?? BUILTIN_BACKEND_ID
  const choices = backendChoices()

  if (!requested) {
    return {
      kind: "openOverlay",
      overlay: {
        kind: "select",
        title: "Agent backend",
        items: choices.map((id) => ({ id, label: id, hint: backendHint(id, current) })),
        index: Math.max(0, choices.indexOf(current)),
        onSelectCommand: "backend",
      },
    }
  }
  if (!choices.includes(requested)) {
    return {
      kind: "notice",
      message: `Unknown backend "${requested}" — choose: ${choices.join(", ")}`,
    }
  }
  if (requested === current) {
    return { kind: "notice", message: `Already on ${requested}.` }
  }
  return { kind: "backend", backend: requested }
}

export const backendCommand: CommandDescriptor = {
  name: "backend",
  description: "switch the agent backend (builtin / codex / claude-code / …)",
  category: "config",
  argumentHint: "[builtin | codex | claude-code | … — run /backend to list]",
  handler: handle,
}
