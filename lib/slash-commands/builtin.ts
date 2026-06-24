// Built-in `/command` registry surfaced inside the chat composer.
//
// Two flavours:
//   - **Action** commands carry a `handler` that runs synchronously when the
//     user picks them. The composer clears the textarea and does NOT send a
//     turn. Use this for client-side state changes (clear chat, open settings,
//     switch model).
//   - **Template** commands carry a `template` string that is dropped into the
//     textarea verbatim, with `$1..$9` and `$ARGUMENTS` substituted from
//     whatever the user typed after the slash command name. The user can edit
//     the result and press Enter to send.
//
// A command with both fields is treated as Action (handler wins).

import type { ChatStatus, PermissionMode } from "@/stores/chat"
import { useChatStore } from "@/stores/chat"
import type { SettingsSectionId } from "@/components/settings/settings-nav-config"
import {
  handleCompact,
  handleContext,
  handleCost,
  handleDoctor,
  handleStatus,
} from "./actions/diagnostics"
import { handleBalance, handleLogin, handleModels, handleUsage } from "./actions/billing"
import { seedBuiltinSlashCommands } from "./registry"
import type { SystemMessageBlock, SlashCommandResultBlock } from "./system-blocks"
import { handleReset, handleResume, handleSessions } from "./actions/sessions"
import { dispatchGoalSubcommand } from "./actions/goal"
import { dispatchLoopSubcommand } from "./actions/loop"
import { dispatchRememberCommand } from "./actions/remember"
import { WORKFLOW_SLASH_COMMANDS } from "./actions/workflow"

/**
 * Names of the sections in the Settings page (URL `?section=` values).
 *
 * Re-exported from `settings-nav-config` so slash-command handlers stay in
 * sync with the actual navigation map without a parallel union to
 * forget-to-update.
 */
export type SettingsTab = SettingsSectionId

/** What the dispatcher hands an Action command's handler. */
export interface SlashContext {
  /** Argument substring after the command name, trimmed. */
  args: string
  /** Currently active session id, if any. */
  activeSessionId: string | null
  /** Status of the active turn. Lets handlers refuse to run mid-stream. */
  chatStatus: ChatStatus
  /** Live read of the active session's permission mode (or null = inherit). */
  currentPermissionMode: PermissionMode | null
  /** Triggers the new-chat flow used by the sidebar's "New" button. */
  startNewSession: () => Promise<void> | void
  /** Open one of the right-rail settings panels. */
  openSettings: (tab: SettingsSectionId) => void
  /** Force a permission mode change (Shift+Tab equivalent). */
  setPermissionMode: (mode: PermissionMode | null) => void
  /**
   * Push a system message into the active session. Accepts markdown (rendered
   * as text — used by /help, /status, …), a structured
   * {@link SystemMessageBlock} that renders as a diagnostics card
   * (/context, /usage, /cost), or a {@link SlashCommandResultBlock} that
   * renders as a compact inline result chip (/resume, …).
   */
  pushSystemMessage: (payload: string | SystemMessageBlock | SlashCommandResultBlock) => void
}

export type SlashScope = "builtin" | "project" | "user"

/** A single parameter the command's guided form collects. */
export interface SlashParamSpec {
  /** Flag/positional key, e.g. `provider` → `--provider <value>`. */
  name: string
  /** User-facing field label. */
  label: string
  /** Input kind. `enum` renders a select from `options`. */
  type: "string" | "enum" | "number" | "boolean"
  /** Required fields block form submission until filled. */
  required?: boolean
  /** Choices for `type: "enum"`. */
  options?: string[]
  /** Pre-filled default value. */
  default?: string
  /** Placeholder for free-text inputs. */
  placeholder?: string
  /**
   * How the value is emitted into the args string:
   *   - `"flag"` (default) → `--name value`
   *   - `"positional"` → bare `value` (order follows the spec list)
   */
  style?: "flag" | "positional"
}

export interface SlashCommand {
  /** Display name without the leading slash. May contain `/` for nested commands. */
  name: string
  description: string
  scope: SlashScope
  /** Hint text rendered next to the name (e.g. "<file>"). */
  argumentHint?: string
  /** Action handler. When set, picking the command runs it instead of inserting text. */
  handler?: (ctx: SlashContext) => void | Promise<void>
  /** Prompt template inserted into the textarea. Supports `$1..$9` and `$ARGUMENTS`. */
  template?: string
  /** True for items that point at unfinished sidecar features (rendered greyed out). */
  disabled?: boolean
  /** Source file for custom commands (project / user `.claude/commands/...`). */
  filePath?: string
  /** Per-command model override applied to the next send when this template fires. */
  model?: string
  /**
   * Tools the command's body expects to call. Forwarded to SendOptions.allowedTools
   * for the turn that runs this command.
   */
  allowedTools?: string[]
  /** Absolute paths to grant the SDK read access to for this turn. */
  paths?: string[]
  /**
   * When `true`, hide from the user-facing slash-command picker. The command
   * is still loaded and can be referenced programmatically. Mirrors Claude
   * Code's `user-invocable: false` and `disable-model-invocation: true`.
   */
  hiddenFromPicker?: boolean
  /**
   * Grouping key used by surfaces that list commands by section — currently
   * the tray's "All Commands ▶" submenu (`lib/tray/all-commands.ts`).
   * Free-form, but the tray groups by these canonical buckets:
   * `chat | diagnostics | system | goal | template | help | plugins`.
   * Defaults to `"chat"` when omitted.
   */
  category?: string
  /**
   * Optional structured parameters. When present, picking the command opens a
   * guided form (see `components/chat/composer/command-param-form.tsx`) instead
   * of inserting raw text; the collected values are built into the args string
   * via `lib/slash-commands/build-args.ts`.
   */
  params?: SlashParamSpec[]
}

const HELP_BODY_HEADER =
  "Available commands. Type `/` again to filter. Items with a colon (·) point at a settings panel."

function buildHelpText(commands: SlashCommand[]): string {
  const groups: Record<SlashScope, SlashCommand[]> = {
    builtin: [],
    project: [],
    user: [],
  }
  for (const c of commands) groups[c.scope].push(c)
  const sections: string[] = [HELP_BODY_HEADER]
  for (const [scope, list] of Object.entries(groups) as [SlashScope, SlashCommand[]][]) {
    if (!list.length) continue
    sections.push(`\n**${scope}**`)
    for (const c of list) {
      const hint = c.argumentHint ? ` \`${c.argumentHint}\`` : ""
      sections.push(`- \`/${c.name}\`${hint} — ${c.description}`)
    }
  }
  return sections.join("\n")
}

export const BUILTIN_SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "clear",
    description: "Start a fresh chat session, archiving the current one.",
    scope: "builtin",
    category: "chat",
    handler: async (ctx) => {
      await ctx.startNewSession()
    },
  },
  {
    name: "help",
    description: "List all available commands.",
    scope: "builtin",
    category: "help",
    handler: (ctx) => {
      ctx.pushSystemMessage(buildHelpText(BUILTIN_SLASH_COMMANDS))
    },
  },
  {
    name: "model",
    description: "Switch the model for this session.",
    scope: "builtin",
    category: "system",
    handler: (ctx) => ctx.openSettings("general"),
  },
  {
    name: "agents",
    description: "Open the characters / agents panel.",
    scope: "builtin",
    category: "system",
    handler: (ctx) => ctx.openSettings("characters"),
  },
  {
    name: "mcp",
    description: "Manage MCP servers attached to this session.",
    scope: "builtin",
    category: "system",
    handler: (ctx) => ctx.openSettings("mcp"),
  },
  {
    name: "permissions",
    description: "Cycle the permission mode (default → acceptEdits → plan → bypass).",
    scope: "builtin",
    category: "system",
    handler: (ctx) => {
      const order: (PermissionMode | null)[] = [null, "acceptEdits", "plan", "bypassPermissions"]
      const idx = order.indexOf(ctx.currentPermissionMode)
      const next = order[(idx + 1) % order.length]
      ctx.setPermissionMode(next)
    },
  },
  {
    name: "init",
    description: "Have Claude generate or refresh CLAUDE.md from this codebase.",
    scope: "builtin",
    category: "template",
    template:
      "Please analyse this repository and produce (or update) the CLAUDE.md " +
      "file at the project root. Cover: project overview, dev commands, " +
      "architecture and conventions, and anything else a new contributor " +
      "would want to know. Use the existing CLAUDE.md as a starting point " +
      "if one exists.",
  },
  {
    name: "review",
    description: "Ask Claude to code-review the current changes.",
    scope: "builtin",
    category: "template",
    argumentHint: "<focus area?>",
    template:
      "Please code-review the current uncommitted changes in this repo. " +
      "Focus on correctness, edge cases, and readability. " +
      "$ARGUMENTS",
    params: [
      {
        name: "focus",
        label: "Extra focus area",
        type: "string",
        style: "positional",
        placeholder: "e.g. error handling, performance",
      },
    ],
  },
  {
    name: "reset",
    description: "Alias of /clear — start a fresh session.",
    scope: "builtin",
    category: "chat",
    handler: handleReset,
  },
  {
    name: "sessions",
    description: "List all sessions with their last-updated time.",
    scope: "builtin",
    category: "chat",
    handler: handleSessions,
  },
  {
    name: "resume",
    description: "Switch to an existing session by id or title (substring match).",
    argumentHint: "<id or title>",
    scope: "builtin",
    category: "chat",
    handler: handleResume,
  },
  {
    name: "status",
    description: "Show this session's effective config + sidecar / API key health.",
    scope: "builtin",
    category: "diagnostics",
    handler: handleStatus,
  },
  {
    name: "cost",
    description: "Show cumulative token usage and cost for this session.",
    scope: "builtin",
    category: "diagnostics",
    handler: handleCost,
  },
  {
    name: "permission-mode",
    description:
      "Set permission mode directly (default | acceptEdits | plan | bypassPermissions). " +
      "With no arg, cycles like /permissions.",
    argumentHint: "<mode?>",
    scope: "builtin",
    category: "system",
    handler: (ctx) => {
      const arg = ctx.args.trim()
      if (!arg) {
        const order: (PermissionMode | null)[] = [null, "acceptEdits", "plan", "bypassPermissions"]
        const idx = order.indexOf(ctx.currentPermissionMode)
        const next = order[(idx + 1) % order.length]
        ctx.setPermissionMode(next)
        return
      }
      switch (arg) {
        case "default":
          ctx.setPermissionMode(null)
          return
        case "acceptEdits":
        case "plan":
        case "bypassPermissions":
          ctx.setPermissionMode(arg)
          return
        default:
          ctx.pushSystemMessage(
            `Unknown permission mode: \`${arg}\`. ` +
              "Valid modes: default, acceptEdits, plan, bypassPermissions."
          )
      }
    },
  },
  {
    name: "add-dir",
    description:
      "Grant the current session read access to an additional directory (absolute path).",
    argumentHint: "<absolute path>",
    scope: "builtin",
    category: "system",
    handler: (ctx) => {
      const path = ctx.args.trim()
      if (!path) {
        ctx.pushSystemMessage(
          "Usage: `/add-dir <absolute path>` — e.g. `/add-dir D:\\\\workspace\\\\docs`."
        )
        return
      }
      // We don't stat the path here — Tauri's FS scope already gates access.
      // Treat the entry as a directory (the SDK consumes this as
      // additionalDirectories, not file-level reads).
      useChatStore.getState().addReferencedPath({
        absolute: path,
        relative: path,
        isDir: true,
      })
      ctx.pushSystemMessage(`Added \`${path}\` to this session's directory list.`)
    },
  },
  {
    name: "compact",
    description: "Summarise older turns and free up the context window.",
    scope: "builtin",
    category: "diagnostics",
    argumentHint: "[focus]",
    // Routes a `claude_compact` control message to the sidecar so manual
    // compaction works on BOTH paths: the generic (AI-SDK) path runs a summary
    // now; the Anthropic path pushes a `/compact` turn the Agent SDK intercepts.
    // An optional focus arg (e.g. `/compact the API changes`) steers what the
    // summary preserves.
    handler: handleCompact,
  },
  {
    name: "context",
    description: "Show this session's local message + token totals.",
    scope: "builtin",
    category: "diagnostics",
    handler: handleContext,
  },
  {
    name: "doctor",
    description: "Run a runtime + auth + MCP health check.",
    scope: "builtin",
    category: "diagnostics",
    handler: handleDoctor,
  },
  {
    name: "usage",
    description: "Show Anthropic subscription quota windows (5h / 7d) and reset countdowns.",
    scope: "builtin",
    category: "diagnostics",
    handler: handleUsage,
  },
  {
    name: "balance",
    description: "Show the latest balance for each subscription provider account.",
    scope: "builtin",
    category: "diagnostics",
    handler: handleBalance,
  },
  {
    name: "models",
    description: "Sync the models.dev catalog and report provider / model counts.",
    scope: "builtin",
    category: "system",
    handler: handleModels,
  },
  {
    name: "login",
    description: "Open Settings → Subscription to sign in to a provider.",
    scope: "builtin",
    category: "system",
    handler: handleLogin,
  },
  {
    name: "export",
    description: "Open the data settings panel to back up or export this session.",
    scope: "builtin",
    category: "system",
    handler: (ctx) => {
      ctx.pushSystemMessage(
        "Opened Settings → Data. Use the **Download** icon in the chat header for a per-session export."
      )
      ctx.openSettings("data")
    },
  },
  {
    name: "goal",
    description:
      "Set a standing goal — the agent auto-continues toward it until done or stopped (ADR-0013).",
    scope: "builtin",
    category: "goal",
    argumentHint: "<objective | status | pause | resume | stop | update <text> | show>",
    handler: async (ctx) => {
      const result = await dispatchGoalSubcommand(ctx)
      if (!result) return
      if (result.system) ctx.pushSystemMessage(result.system)
      if (result.openGoalsSettings) ctx.openSettings("goals")
      if (result.dispatchPrompt) {
        // Phase 1: surface the would-be prompt as an additional system note
        // so the user knows the model will see the objective change on the
        // next turn. Phase 2 will wire this directly into the chat hook's
        // silent-send path.
        ctx.pushSystemMessage(
          `_Objective change prompt staged — the model will be told on the next turn._`
        )
      }
    },
  },
  {
    name: "loop",
    description:
      "Repeat a prompt — fixed interval (/loop 5m …) via the scheduler, or self-paced (/loop …) with model-chosen delays.",
    scope: "builtin",
    category: "loop",
    argumentHint: "<[interval] prompt | status | list | pause | resume | stop>",
    handler: async (ctx) => {
      // Self-paced kick-off is NOT dispatched here: LoopRuntime fires its
      // kickoff listener and the chat hook sends iteration 1 silently —
      // the same path as every later continuation (and it bypasses the
      // fresh-user-message preempt that would otherwise pause the loop).
      const result = await dispatchLoopSubcommand(ctx)
      if (result?.system) ctx.pushSystemMessage(result.system)
    },
  },
  {
    name: "remember",
    description: "Save a durable fact about you to long-term memory.",
    scope: "builtin",
    category: "chat",
    argumentHint: "<fact>",
    handler: async (ctx) => {
      const result = await dispatchRememberCommand(ctx)
      if (result?.system) ctx.pushSystemMessage(result.system)
    },
  },
  // Workflow Copilot commands — only active inside workflow-editor sessions.
  // Each handler self-gates on activeSessionId so the picker never lists
  // them in the main chat.
  ...WORKFLOW_SLASH_COMMANDS,
]

// Phase 3: mirror BUILTIN_SLASH_COMMANDS into the unified registry as
// descriptor-only entries so settings UIs (Phase 7) can enumerate every
// command — built-in, custom, and plugin-contributed — from one place.
// This is a side-effect of importing this module, which the chat composer
// already does.
seedBuiltinSlashCommands(BUILTIN_SLASH_COMMANDS)

/**
 * Replace `$ARGUMENTS` and `$1..$9` placeholders in a template body. The
 * `args` string is split on whitespace for positional substitution; whole
 * `args` is used for `$ARGUMENTS`. Unfilled positionals collapse to empty.
 */
export function applyTemplate(template: string, args: string): string {
  const positional = args.trim().split(/\s+/).filter(Boolean)
  let out = template.replace(/\$ARGUMENTS/g, args.trim())
  out = out.replace(/\$([1-9])/g, (_, n) => positional[Number(n) - 1] ?? "")
  return out
}
