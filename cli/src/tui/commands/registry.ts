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
import { deriveEffortSliderState } from "../../config/thinking"
import { collectModelOptions } from "../components/model-options"
import { lastUserText, nthAssistantText } from "../state/selectors"
import { aboutLine, buildToolsCatalogDocument } from "./builtins"
import { buildCommandHelpDocument } from "./command-help"
import { settingsSections } from "../runtime/settings-sections"
import { collectProviderOptions } from "./provider-options"
import { statusbarCommand } from "./statusbar-command"
import { mascotCommand } from "./mascot-command"
import { themeCommand } from "./theme-command"
import { outputStyleCommand } from "./output-style-command"
import { agentModeCommand } from "./agent-mode-command"
import { layoutCommand } from "./layout-command"
import { mouseCommand } from "./mouse-command"
import type { CommandDescriptor, CommandEffect } from "./types"

/** Back-compat alias for consumers that referenced the old shape. */
export type SlashCommand = CommandDescriptor

/** Settings fields edited via the panel's single-field form (`/settings <field> <value>`). */
const SETTINGS_FORM_FIELDS = ["systemPrompt", "skillDirs", "allowedTools"] as const

// ── Core command catalog ──────────────────────────────────────────────────────
// Order is meaningful: it drives the palette + `/help` listing and keeps the
// `mo` prefix-match stable (`model` before `mode`).

export const CORE_COMMANDS: CommandDescriptor[] = [
  {
    name: "settings",
    aliases: ["config"],
    description: "open the unified settings panel",
    category: "config",
    handler: (ctx) => {
      // `/settings <field> <value>` applies a file-only field from the panel's
      // single-field form; bare `/settings` opens the panel.
      const args = ctx.args.trim()
      if (args) {
        const [field, ...rest] = args.split(/\s+/)
        if ((SETTINGS_FORM_FIELDS as readonly string[]).includes(field)) {
          return { kind: "settingsSet", field, value: rest.join(" ") }
        }
      }
      return {
        kind: "openOverlay",
        overlay: { kind: "settings", sections: settingsSections(ctx.config), section: 0, index: 0 },
      }
    },
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
    name: "think",
    aliases: ["thinking", "effort"],
    description: "set the reasoning effort (thinking level)",
    category: "config",
    handler: (ctx) => ({
      kind: "openOverlay",
      // Seed the slider from the persisted level so it opens on the current pick.
      overlay: { kind: "effortSlider", ...deriveEffortSliderState(ctx.config.thinkingLevel) },
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
  mascotCommand,
  themeCommand,
  outputStyleCommand,
  agentModeCommand,
  layoutCommand,
  mouseCommand,
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
    description: "browse the built-in tool catalog",
    category: "system",
    handler: (ctx) => ({
      kind: "openOverlay",
      overlay: {
        kind: "document",
        title: "Built-in tools",
        body: buildToolsCatalogDocument(ctx.config.builtinTools),
        format: "markdown",
      },
    }),
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
    // Destructive: confirm before wiping the conversation. The confirm overlay
    // re-runs `/clear --yes`, which performs the actual reset (reuses the
    // ConfirmOverlay that previously only `/init` used).
    handler: (ctx) => {
      if (ctx.args.trim() === "--yes") return { kind: "clear" }
      return {
        kind: "openOverlay",
        overlay: {
          kind: "confirm",
          title: "Start a fresh session?",
          body: "This archives the current conversation and starts a new one. It can't be undone.",
          format: "text",
          onConfirmCommand: "clear --yes",
        },
      }
    },
  },
  {
    name: "help",
    description: "show the command list, or detail on one command (/help <command>)",
    category: "system",
    argumentHint: "[command]",
    // Bare `/help` opens the category-grouped overlay; `/help <command>` opens a
    // focused detail document (description · aliases · usage · args · subcommands)
    // so the user can drill into one command without scanning the whole list.
    handler: (ctx) => {
      const name = ctx.args.trim().replace(/^\//, "").split(/\s+/)[0]
      if (!name) return { kind: "openOverlay", overlay: { kind: "help" } }
      const target = getCommand(name)
      if (!target) {
        return { kind: "notice", message: `Unknown command /${name} — /help for the list` }
      }
      const doc = buildCommandHelpDocument(target)
      return {
        kind: "openOverlay",
        overlay: { kind: "document", title: doc.title, body: doc.body, format: "markdown" },
      }
    },
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
