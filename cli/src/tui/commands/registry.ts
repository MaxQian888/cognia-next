/**
 * The slash-command registry for the interactive TUI — a single source of truth
 * for the `/` palette, `/help`, and the dispatcher.
 *
 * Map-based (insertion-ordered) so commands can be contributed from feature
 * modules (`cognia-commands.ts`, `mcp-commands.ts`, …) without editing a central
 * switch. Core commands seed at module load; features call `registerCommands`
 * from the `commands/index.ts` barrel the App imports once.
 *
 * Each command's handler is a PURE function of a read-only {@link CommandContext}
 * returning a {@link CommandEffect}; the App interprets the effect. See
 * `dispatch.ts`.
 */
import { PERMISSION_MODES } from "../../config/schema"
import { collectModelOptions } from "../components/model-options"
import { lastUserText, nthAssistantText } from "../state/selectors"
import { aboutLine, describeBuiltinTools } from "./builtins"
import { configMenuRows } from "./config-menu"
import { collectProviderOptions } from "./provider-options"
import { statusbarCommand } from "./statusbar-command"
import type { CommandDescriptor, CommandEffect } from "./types"

/** Back-compat alias for consumers that referenced the old shape. */
export type SlashCommand = CommandDescriptor

// ── Core command catalog ──────────────────────────────────────────────────────
// Order is meaningful: it drives the palette + `/help` listing and keeps the
// `mo` prefix-match stable (`model` before `mode`).

export const CORE_COMMANDS: CommandDescriptor[] = [
  {
    name: "config",
    aliases: ["settings"],
    description: "open the settings panel",
    category: "config",
    handler: (ctx) => ({
      kind: "openOverlay",
      overlay: { kind: "config", rows: configMenuRows(ctx.config), index: 0 },
    }),
  },
  {
    name: "provider",
    description: "switch the AI provider",
    category: "config",
    handler: (ctx) => ({
      kind: "openOverlay",
      overlay: { kind: "provider", options: collectProviderOptions(ctx.config), index: 0 },
    }),
  },
  {
    name: "model",
    description: "switch the model",
    category: "config",
    handler: (ctx) => {
      const options = collectModelOptions(ctx.config)
      if (options.length === 0) {
        return {
          kind: "notice",
          message: "No models configured. Set one with `cognia-agent config set model <id>`.",
        }
      }
      return { kind: "openOverlay", overlay: { kind: "model", options, index: 0 } }
    },
  },
  {
    name: "mode",
    description: "switch the permission mode",
    category: "config",
    handler: () => ({
      kind: "openOverlay",
      overlay: { kind: "mode", options: [...PERMISSION_MODES], index: 0 },
    }),
  },
  {
    name: "sessions",
    description: "browse and resume past sessions",
    category: "session",
    handler: () => ({ kind: "openSessions" }),
  },
  {
    name: "usage",
    aliases: ["cost"],
    description: "show token and cost usage",
    category: "config",
    handler: () => ({ kind: "openOverlay", overlay: { kind: "usage" } }),
  },
  statusbarCommand,
  {
    name: "retry",
    aliases: ["resend"],
    description: "re-send the last message",
    category: "chat",
    handler: (ctx) => {
      const prev = lastUserText(ctx.state)
      return prev
        ? { kind: "send", prompt: prev }
        : { kind: "notice", message: "Nothing to re-send yet." }
    },
  },
  {
    name: "copy",
    description: "copy a reply to the clipboard (last, or the Nth-latest)",
    category: "chat",
    argumentHint: "[n]",
    handler: (ctx) => {
      const arg = ctx.args.trim()
      const n = arg ? Number(arg) : 1
      if (!Number.isInteger(n) || n < 1) {
        return {
          kind: "notice",
          message: "Usage: /copy [n] — n is a positive reply index (1 = latest).",
        }
      }
      const reply = nthAssistantText(ctx.state, n)
      return reply
        ? { kind: "copy", text: reply }
        : { kind: "notice", message: n === 1 ? "No reply to copy yet." : `No reply #${n} to copy.` }
    },
  },
  {
    name: "tools",
    description: "list the enabled built-in tools",
    category: "system",
    handler: (ctx) => ({ kind: "notice", message: describeBuiltinTools(ctx.config.builtinTools) }),
  },
  {
    name: "cwd",
    description: "show the working directory",
    category: "system",
    handler: (ctx) => ({ kind: "notice", message: ctx.config.cwd }),
  },
  {
    name: "about",
    aliases: ["version"],
    description: "show version and provider info",
    category: "system",
    handler: (ctx) => ({ kind: "notice", message: aboutLine(ctx.config, ctx.version) }),
  },
  {
    name: "handoff",
    description: "push this session to the desktop app",
    category: "session",
    handler: () => ({ kind: "handoff" }),
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "start a fresh session",
    category: "session",
    handler: () => ({ kind: "clear" }),
  },
  {
    name: "help",
    description: "show the command list",
    category: "system",
    handler: () => ({ kind: "openOverlay", overlay: { kind: "help" } }),
  },
  {
    name: "exit",
    aliases: ["quit"],
    description: "quit",
    category: "system",
    handler: () => ({ kind: "exit" }),
  },
]

// ── Registry ───────────────────────────────────────────────────────────────────

const registry = new Map<string, CommandDescriptor>()
const aliasIndex = new Map<string, string>()

function indexAlias(desc: CommandDescriptor): void {
  for (const alias of desc.aliases ?? []) aliasIndex.set(alias.toLowerCase(), desc.name)
}

/** Register one command. Throws on a name/alias collision so mistakes surface. */
export function registerCommand(desc: CommandDescriptor): void {
  const name = desc.name.toLowerCase()
  if (registry.has(name) || aliasIndex.has(name)) {
    throw new Error(`duplicate slash command: ${desc.name}`)
  }
  for (const alias of desc.aliases ?? []) {
    const a = alias.toLowerCase()
    if (registry.has(a) || aliasIndex.has(a)) {
      throw new Error(`alias "${alias}" of /${desc.name} collides with an existing command`)
    }
  }
  registry.set(name, desc)
  indexAlias(desc)
}

/** Register many commands in order. */
export function registerCommands(descs: CommandDescriptor[]): void {
  for (const d of descs) registerCommand(d)
}

/** All registered commands, in registration order. */
export function listCommands(): CommandDescriptor[] {
  return [...registry.values()]
}

/** Registered commands the palette + `/help` should show (drops `hidden`). */
export function listVisibleCommands(): CommandDescriptor[] {
  return listCommands().filter((c) => !c.hidden)
}

/** Resolve a typed command name or alias to its descriptor. */
export function getCommand(name: string): CommandDescriptor | undefined {
  const lower = name.toLowerCase()
  const direct = registry.get(lower)
  if (direct) return direct
  const aliased = aliasIndex.get(lower)
  return aliased ? registry.get(aliased) : undefined
}

function seedCore(): void {
  registry.clear()
  aliasIndex.clear()
  for (const c of CORE_COMMANDS) registerCommand(c)
}

/** Test-only: wipe the registry back to the core catalog. */
export function __resetForTesting(): void {
  seedCore()
}

seedCore()

// Re-export so a CommandEffect consumer needn't reach into `./types`.
export type { CommandEffect }
