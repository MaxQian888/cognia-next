/**
 * Pure model for the unified `/settings` panel — the single aggregated entry
 * point that replaces the scattered `/model`, `/theme`, `/statusbar`, … commands
 * and surfaces the previously file-only config knobs (`builtinTools`, `webTools`,
 * `skillDirs`, hook overrides, system prompt, terminal/mouse/clipboard, the
 * reliability timeouts, …).
 *
 * This module owns NO UI and NO persistence: it turns a {@link ResolvedConfig}
 * into a list of sections → rows → controls. The `SettingsOverlay` component
 * renders it; `App.tsx` interprets a row's {@link SettingsControl} into the
 * EXISTING overlays / commands / `mutate.ts` helpers. Keeping it pure means the
 * whole panel structure is unit-testable without rendering.
 */
import {
  CLI_LOG_LEVELS,
  CLI_LOGGING_DEFAULTS,
  CLIPBOARD_OSC52_MODES,
  DEFAULT_COAUTHOR_TRAILER,
  DEFAULT_MOUSE_MODE,
  DEFAULT_SELECTION_MODE,
  DEFAULT_OSC52_MAX_BYTES,
  DEFAULT_PR_FOOTER,
  MASCOT_STYLES,
  OUTPUT_STYLES,
  RENDER_DEFAULTS,
  STATUS_THEMES,
  resolveCliLoggingConfig,
  resolveGitWorkflowConfig,
  resolveRenderConfig,
  type CliLoggingConfig,
  type ResolvedConfig,
  type ResolvedRenderConfig,
} from "../../config/schema"
import { DEFAULT_LAYOUT } from "../layout-mode"
import {
  supportsFeature,
  unsupportedFeatureMessage,
  type BackendCapabilities,
  type BackendFeature,
} from "./backend-capabilities"
import type { BuiltinToolsConfig } from "@cognia/agent-config-types"
import { DEFAULT_BUILTIN_TOOLS } from "@cognia/agent-config-types"
import { BUILTIN_HOOKS } from "@/lib/claude/hooks/builtin-hooks"
import { THEME_CHOICES } from "../theme/resolve"
import { DEFAULT_THEME_NAME } from "../theme/builtins"
import {
  KEYBINDABLE_ACTIONS,
  KEYBINDING_LABELS,
  formatKeySpec,
  resolveKeybindings,
} from "../input/keybindings"
import type { BooleanFlagKey, NumberConfigKey, SettableKey } from "../../config/mutate"

export type SettingsSectionId =
  | "model"
  | "appearance"
  | "display"
  | "tools"
  | "git"
  | "behavior"
  | "terminal"
  | "logging"
  | "advanced"
  | "keybindings"
  | "workspace"

/** Identifies what a row's chosen value persists/applies to. App maps each to an
 * existing reducer action + `mutate.ts` helper. */
export type SettingsApplyTarget =
  | { kind: "theme" }
  | { kind: "outputStyle" }
  | { kind: "statusTheme" }
  | { kind: "mascotEnabled" }
  | { kind: "mascotStyle" }
  | { kind: "flag"; key: BooleanFlagKey }
  /** A top-level scalar config value (e.g. `skillLoadMode`), set via setConfigValue. */
  | { kind: "configValue"; key: SettableKey }
  /** A top-level numeric config value (timeouts / budgets), set via setNumberConfig. */
  | { kind: "numberValue"; key: NumberConfigKey }
  /** A nested `clipboard.*` value (OSC 52 mode / byte cap), set via setClipboardConfig. */
  | { kind: "clipboard"; key: "osc52" | "osc52MaxBytes" }
  | { kind: "builtinTool"; key: keyof BuiltinToolsConfig }
  /** A nested `git.*` boolean knob (co-author trailer / PR footer), set via
   * setGitWorkflowConfig. Toggling ON restores the default text; a custom
   * string is authored in config.json and survives until toggled off. */
  | { kind: "gitWorkflow"; key: "coauthorTrailer" | "prFooter" }
  /** A nested `logging.*` value (mcp.log level / rotation sizes), set via
   * setLoggingConfig. Read live by the log-file writers — no SendOptions
   * invalidation needed. */
  | { kind: "logging"; key: keyof CliLoggingConfig }
  | { kind: "hook"; id: string }
  /** A transcript render preference (boolean toggle or numeric enum). */
  | { kind: "render"; key: keyof ResolvedRenderConfig }

/** A single-field editor the App opens via FormOverlay / a dedicated command. */
export type SettingsFormField =
  | "systemPrompt"
  | "skillDirs"
  | "allowedTools"
  | "customTheme"
  | "gitProtectedBranches"
  | "gitBaseBranch"

/** How a row behaves on the keyboard. */
export type SettingsControl =
  /** ←/→ cycles through `options`; App persists the picked value via `apply`. */
  | { type: "enum"; options: string[]; current: string; apply: SettingsApplyTarget }
  /** Space toggles; App persists via `apply`. */
  | { type: "boolean"; current: boolean; apply: SettingsApplyTarget }
  /** Enter runs this slash command line (delegates to an existing overlay). */
  | { type: "delegate"; command: string }
  /** Enter opens a single-/multi-field editor for a previously file-only field. */
  | { type: "form"; field: SettingsFormField }
  /** Display-only (e.g. working dir, auth). */
  | { type: "readonly" }

export interface SettingsRow {
  id: string
  label: string
  /** Human-readable current value, shown to the right of the label. */
  value: string
  control: SettingsControl
  /** One-line help shown for the focused row (the panel's description strip). */
  description?: string
  /**
   * Why this row cannot be used on the ACTIVE backend, when it cannot.
   *
   * Set rather than hiding the row: a setting that vanishes on Codex reads as a
   * missing feature, while one that says "unavailable on codex — the agent
   * protocol has no equivalent" tells the user what is actually going on. The
   * row still activates; its command re-states the same reason.
   */
  unavailable?: string
}

export interface SettingsSectionView {
  id: SettingsSectionId
  title: string
  rows: SettingsRow[]
}

function onOff(v: boolean): string {
  return v ? "on" : "off"
}

/** Resolve a builtin-tools toggle, falling back to its product default. */
function toolValue(config: ResolvedConfig, key: keyof BuiltinToolsConfig): boolean {
  const v = config.builtinTools[key]
  return v ?? DEFAULT_BUILTIN_TOOLS[key] ?? false
}

/** The current value of a numeric config knob as a display string, or its default. */
function numStr(value: number | undefined, fallback: number): string {
  return String(typeof value === "number" ? value : fallback)
}

/** Friendly labels + help for the builtin-tools toggles, in schema order. */
const BUILTIN_TOOL_ROWS: { key: keyof BuiltinToolsConfig; label: string; desc: string }[] = [
  {
    key: "fileExtras",
    label: "File extras (hash/diff/search)",
    desc: "Hashing, structured diff, and in-file search helpers.",
  },
  {
    key: "coreFiles",
    label: "Core file tools",
    desc: "Read / write / edit files (the workhorse file tools).",
  },
  {
    key: "coreFilesOnAnthropic",
    label: "Core files on Anthropic",
    desc: "Also expose the core file tools on the Anthropic channel.",
  },
  { key: "git", label: "Git tools", desc: "Status / diff / log / add / commit helpers." },
  {
    key: "process",
    label: "Process tools",
    desc: "Start, inspect, and kill background processes.",
  },
  {
    key: "environment",
    label: "Environment tools",
    desc: "Read environment / system information.",
  },
  {
    key: "shellAdvanced",
    label: "Advanced shell",
    desc: "Extra shell primitives beyond a single bash call.",
  },
  { key: "terminalRepl", label: "Terminal REPL", desc: "Persistent interactive REPL sessions." },
  {
    key: "lsp",
    label: "LSP code intelligence",
    desc: "Language-server hover / definitions / diagnostics.",
  },
]

/**
 * Build the full settings panel model from the resolved config. Every section is
 * always present (stable order) so the panel layout is deterministic.
 *
 * `capabilities` describes the backend actually answering. Rows whose setting
 * cannot reach that backend are marked {@link SettingsRow.unavailable} with the
 * reason — the panel used to present every row as live regardless of who was
 * hosting, so on Codex a user could change a value that went nowhere.
 */
export function settingsSections(
  config: ResolvedConfig,
  capabilities?: BackendCapabilities
): SettingsSectionView[] {
  const mascotEnabled = config.mascot?.enabled !== false
  const statusTheme = config.statusBar?.theme ?? "default"
  /** The reason a feature is unreachable here, or undefined when it is fine. */
  const blocked = (feature: BackendFeature): string | undefined =>
    supportsFeature(capabilities, feature)
      ? undefined
      : unsupportedFeatureMessage(capabilities, feature)

  const model: SettingsSectionView = {
    id: "model",
    title: "Model & Reasoning",
    rows: [
      {
        id: "provider",
        label: "Provider",
        value: config.provider,
        control: { type: "delegate", command: "/provider" },
        description: "Which AI provider serves this session (opens the provider picker).",
      },
      {
        id: "model",
        label: "Model",
        value: config.model ?? "default",
        control: { type: "delegate", command: "/model" },
        description: "The model id used for your turns (opens the model picker).",
        ...(() => {
          const reason = blocked("modelPicker")
          return reason ? { unavailable: reason } : {}
        })(),
      },
      {
        id: "mode",
        label: "Permission mode",
        value: config.permissionMode,
        control: { type: "delegate", command: "/mode" },
        description: "How tool calls are approved (default / acceptEdits / plan / bypass / …).",
      },
      {
        id: "thinking",
        label: "Thinking level",
        value: config.thinkingLevel ?? "off",
        control: { type: "delegate", command: "/think" },
        description:
          "Reasoning effort forwarded to the model (off → max; ultracode also enables workflow tools).",
        ...(() => {
          const reason = blocked("thinking")
          return reason ? { unavailable: reason } : {}
        })(),
      },
      {
        id: "subagentModels",
        label: "Subagent models…",
        value: (() => {
          const n = Object.keys(config.subagentModels ?? {}).length
          return n > 0 ? `${n} overridden` : "inherit"
        })(),
        control: { type: "delegate", command: "/agents models" },
        description: "Assign a provider/model to each dispatchable subagent.",
        ...(() => {
          const reason = blocked("subagentModels")
          return reason ? { unavailable: reason } : {}
        })(),
      },
    ],
  }

  const appearance: SettingsSectionView = {
    id: "appearance",
    title: "Appearance",
    rows: [
      {
        id: "theme",
        label: "Theme",
        value: config.theme ?? DEFAULT_THEME_NAME,
        control: {
          type: "enum",
          options: [...THEME_CHOICES],
          current: config.theme ?? DEFAULT_THEME_NAME,
          apply: { kind: "theme" },
        },
        description: "TUI colour theme (built-ins, or reuse your Claude Code / Codex palette).",
      },
      {
        id: "custom-theme",
        label: "Custom theme colours…",
        value: (config.theme ?? "").startsWith("custom:") ? config.theme! : "edit base colours",
        control: { type: "form", field: "customTheme" },
        description: "Author a custom palette on top of a base theme.",
      },
      {
        id: "output-style",
        label: "Output style",
        value: config.outputStyle ?? "default",
        control: {
          type: "enum",
          options: [...OUTPUT_STYLES],
          current: config.outputStyle ?? "default",
          apply: { kind: "outputStyle" },
        },
        description:
          "Response style appended to the system prompt (concise / explanatory / learning).",
      },
      {
        id: "status-theme",
        label: "Status bar colours",
        value: statusTheme,
        control: {
          type: "enum",
          options: [...STATUS_THEMES],
          current: statusTheme,
          apply: { kind: "statusTheme" },
        },
        description: "Status-bar colour palette (default / dim / vivid / mono).",
      },
      {
        id: "status-segments",
        label: "Status bar segments…",
        value: (config.statusBar?.segments ?? []).join(" ") || "default",
        control: { type: "delegate", command: "/statusbar" },
        description: "Which segments the footer shows, and their order.",
      },
      {
        id: "mascot-enabled",
        label: "Mascot",
        value: onOff(mascotEnabled),
        control: { type: "boolean", current: mascotEnabled, apply: { kind: "mascotEnabled" } },
        description: "Show the terminal mascot above the footer.",
      },
      {
        id: "mascot-style",
        label: "Mascot style",
        value: config.mascot?.style ?? "clawd",
        control: {
          type: "enum",
          options: [...MASCOT_STYLES],
          current: config.mascot?.style ?? "clawd",
          apply: { kind: "mascotStyle" },
        },
        description: "Which mascot creature is shown (clawd / cat / robot).",
      },
    ],
  }

  const render = resolveRenderConfig(config.render)
  const display: SettingsSectionView = {
    id: "display",
    title: "Display",
    rows: [
      {
        id: "highlight",
        label: "Syntax-highlight output",
        value: onOff(render.syntaxHighlightInline),
        control: {
          type: "boolean",
          current: render.syntaxHighlightInline,
          apply: { kind: "render", key: "syntaxHighlightInline" },
        },
        description: "Syntax-highlight inline tool/file output (Bash / PS / file reads).",
      },
      {
        id: "lineNumbers",
        label: "File line numbers",
        value: onOff(render.fileLineNumbers),
        control: {
          type: "boolean",
          current: render.fileLineNumbers,
          apply: { kind: "render", key: "fileLineNumbers" },
        },
        description: "Show 1-based line numbers in file/code result views.",
      },
      {
        id: "collapseTools",
        label: "Collapse tool output by default",
        value: onOff(render.collapseToolsByDefault),
        control: {
          type: "boolean",
          current: render.collapseToolsByDefault,
          apply: { kind: "render", key: "collapseToolsByDefault" },
        },
        description: "Start tool-result cells collapsed (Ctrl+T expands).",
      },
      {
        id: "verboseDefault",
        label: "Start in detail (expand-all) mode",
        value: onOff(render.verboseByDefault),
        control: {
          type: "boolean",
          current: render.verboseByDefault,
          apply: { kind: "render", key: "verboseByDefault" },
        },
        description: "Begin each session with every cell expanded.",
      },
      {
        id: "streamReveal",
        label: "Typewriter reveal of streamed replies",
        value: onOff(render.streamReveal),
        control: {
          type: "boolean",
          current: render.streamReveal,
          apply: { kind: "render", key: "streamReveal" },
        },
        description: "Reveal streamed text at a gentle typing cadence (interactive TTY only).",
      },
      {
        id: "clickToExpand",
        label: "Click a cell to expand it",
        value: onOff(render.clickToExpand),
        control: {
          type: "boolean",
          current: render.clickToExpand,
          apply: { kind: "render", key: "clickToExpand" },
        },
        description:
          "Fullscreen only: a mouse click toggles just that cell (disables burst-folding).",
      },
      {
        id: "notify",
        label: "Ring the bell when a turn finishes",
        value: onOff(config.notify === true),
        control: {
          type: "boolean",
          current: config.notify === true,
          apply: { kind: "flag", key: "notify" },
        },
        description: "Ring the terminal bell after a long turn so you can tab away.",
      },
      {
        id: "desktopNotifications",
        label: "Desktop notifications on completion (needs bell on)",
        value: onOff(config.notify === true && config.desktopNotifications !== false),
        control: {
          type: "boolean",
          current: config.desktopNotifications !== false,
          apply: { kind: "flag", key: "desktopNotifications" },
        },
        description:
          "Also fire an OS desktop notification on completion (only when the bell is on).",
      },
      {
        id: "maxLines",
        label: "Inline result line cap",
        value: String(render.toolResultMaxLines),
        control: {
          type: "enum",
          options: [...RESULT_MAX_LINE_OPTIONS],
          current: String(render.toolResultMaxLines),
          apply: { kind: "render", key: "toolResultMaxLines" },
        },
        description: "Max lines of an expanded inline result before the tail is summarised.",
      },
      {
        id: "pagerThreshold",
        label: "Pager threshold (lines)",
        value: String(render.pagerThresholdLines),
        control: {
          type: "enum",
          options: [...PAGER_THRESHOLD_OPTIONS],
          current: String(render.pagerThresholdLines),
          apply: { kind: "render", key: "pagerThresholdLines" },
        },
        description:
          "Above this many lines, show a preview + pager hint instead of the whole body.",
      },
    ],
  }

  const tools: SettingsSectionView = {
    id: "tools",
    title: "Tools & Skills",
    rows: [
      {
        id: "webTools",
        label: "Web tools (search/fetch)",
        value: onOff(config.webTools !== false),
        control: {
          type: "boolean",
          current: config.webTools !== false,
          apply: { kind: "flag", key: "webTools" },
        },
        description: "Expose web_search / web_fetch to the agent.",
      },
      {
        id: "skillTool",
        label: "Skill tool",
        value: onOff(config.skillTool === true),
        control: {
          type: "boolean",
          current: config.skillTool === true,
          apply: { kind: "flag", key: "skillTool" },
        },
        description: "Let the agent load a skill's instructions on demand via the Skill tool.",
      },
      {
        id: "skillLoadMode",
        label: "Skill loading",
        value: (config.skillLoadMode ?? "name") === "name" ? "name-only" : "full bodies",
        control: {
          type: "enum",
          options: ["name", "full"],
          current: config.skillLoadMode ?? "name",
          apply: { kind: "configValue", key: "skillLoadMode" },
        },
        description: "How skills enter the prompt — a name-only catalog vs every full body.",
      },
      {
        id: "slashCommandTool",
        label: "SlashCommand tool",
        value: onOff(config.slashCommandTool === true),
        control: {
          type: "boolean",
          current: config.slashCommandTool === true,
          apply: { kind: "flag", key: "slashCommandTool" },
        },
        description: "Let the agent run a slash command via the SlashCommand tool.",
      },
      {
        id: "externalSkills",
        label: "Reuse external skill dirs",
        value: onOff(config.externalSkills !== false),
        control: {
          type: "boolean",
          current: config.externalSkills !== false,
          apply: { kind: "flag", key: "externalSkills" },
        },
        description: "Also discover Claude Code / Codex / OpenCode skill directories.",
      },
      {
        id: "pluginTools",
        label: "Plugin tools (dynamic workflow)",
        value: onOff(config.pluginTools === true),
        control: {
          type: "boolean",
          current: config.pluginTools === true,
          apply: { kind: "flag", key: "pluginTools" },
        },
        description:
          "Expose the in-tree first-party plugin tools (web-tools, workflow, …) to the agent.",
      },
      {
        id: "autoRoute",
        label: "Auto tier routing (headless run)",
        value: onOff(config.autoRoute === true),
        control: {
          type: "boolean",
          current: config.autoRoute === true,
          apply: { kind: "flag", key: "autoRoute" },
        },
        description: "One-shot/headless run only: route each prompt to the cheapest capable tier.",
      },
      {
        id: "showActiveSkills",
        label: "Announce active skills each turn",
        value: onOff(config.showActiveSkills === true),
        control: {
          type: "boolean",
          current: config.showActiveSkills === true,
          apply: { kind: "flag", key: "showActiveSkills" },
        },
        description: "Print an 'Active skills (N): …' notice whenever a turn loads enabled skills.",
      },
      {
        id: "skillDirs",
        label: "Extra skill dirs…",
        value: (config.skillDirs ?? []).length ? `${config.skillDirs!.length} dirs` : "none",
        control: { type: "form", field: "skillDirs" },
        description: "Extra directories to discover SKILL.md skills from.",
      },
      {
        id: "allowedTools",
        label: "Allowed tools allowlist…",
        value: (config.allowedTools ?? []).length ? `${config.allowedTools!.length} tools` : "all",
        control: { type: "form", field: "allowedTools" },
        description: "Restrict the agent to an allow-list of tools (empty = all tools allowed).",
      },
      ...BUILTIN_TOOL_ROWS.map((t): SettingsRow => ({
        id: `tool:${t.key}`,
        label: t.label,
        value: onOff(toolValue(config, t.key)),
        control: {
          type: "boolean",
          current: toolValue(config, t.key),
          apply: { kind: "builtinTool", key: t.key },
        },
        description: t.desc,
      })),
    ],
  }

  const gitCfg = resolveGitWorkflowConfig(config.git)
  const git: SettingsSectionView = {
    id: "git",
    title: "Git & PRs",
    rows: [
      {
        id: "gitProtectedBranches",
        label: "Protected branches…",
        value: gitCfg.protectedBranches.join(" ") || "none",
        control: { type: "form", field: "gitProtectedBranches" },
        description: "Branches /commit refuses to commit to directly (space-separated).",
      },
      {
        id: "gitBaseBranch",
        label: "PR base branch…",
        value: gitCfg.baseBranch ?? "auto (main → master)",
        control: { type: "form", field: "gitBaseBranch" },
        description: "Base branch /pr targets. Empty = auto-detect main → master.",
      },
      {
        id: "gitCoauthorTrailer",
        label: "Commit co-author trailer",
        value:
          gitCfg.coauthorTrailer === null
            ? "off"
            : gitCfg.coauthorTrailer === DEFAULT_COAUTHOR_TRAILER
              ? "on"
              : "custom",
        control: {
          type: "boolean",
          current: gitCfg.coauthorTrailer !== null,
          apply: { kind: "gitWorkflow", key: "coauthorTrailer" },
        },
        description:
          "Append the Co-Authored-By trailer to /commit messages (custom text: config.json git.coauthorTrailer).",
      },
      {
        id: "gitPrFooter",
        label: "PR body footer",
        value:
          gitCfg.prFooter === null
            ? "off"
            : gitCfg.prFooter === DEFAULT_PR_FOOTER
              ? "on"
              : "custom",
        control: {
          type: "boolean",
          current: gitCfg.prFooter !== null,
          apply: { kind: "gitWorkflow", key: "prFooter" },
        },
        description:
          "Append the Claude Code footer to /pr bodies (custom text: config.json git.prFooter).",
      },
    ],
  }

  const behavior: SettingsSectionView = {
    id: "behavior",
    title: "Behavior & Hooks",
    rows: [
      {
        id: "systemPrompt",
        label: "System prompt…",
        value: config.systemPrompt ? "set" : "none",
        control: { type: "form", field: "systemPrompt" },
        description: "Extra system-prompt text prepended to every turn.",
      },
      ...BUILTIN_HOOKS.map((h): SettingsRow => {
        const enabled = config.builtinHookOverrides?.[h.id] ?? h.defaultEnabled
        return {
          id: `hook:${h.id}`,
          label: `Hook: ${h.id}`,
          value: onOff(enabled),
          control: { type: "boolean", current: enabled, apply: { kind: "hook", id: h.id } },
          description: h.description ?? "Enable or disable this built-in hook.",
        }
      }),
    ],
  }

  // `config.editor` is always normalized to the object form by the loader.
  const editorLabel = config.editor?.command || "auto-detect"
  const terminal: SettingsSectionView = {
    id: "terminal",
    title: "Terminal & Input",
    rows: [
      {
        id: "layout",
        label: "Layout",
        value: config.layout ?? DEFAULT_LAYOUT,
        control: { type: "delegate", command: "/layout" },
        description: "Fullscreen (pinned banner/composer) vs native terminal scrollback.",
      },
      {
        id: "mouse",
        label: "Mouse model",
        value: config.mouse ?? DEFAULT_MOUSE_MODE,
        control: { type: "delegate", command: "/mouse" },
        description:
          "Wheel-scroll the transcript vs native click-drag text selection (fullscreen).",
      },
      {
        id: "selection",
        label: "Drag to select",
        value: config.selection ?? DEFAULT_SELECTION_MODE,
        control: { type: "delegate", command: "/select" },
        description:
          "In-app text selection over the rendered frame; auto-copy puts it on the clipboard on release.",
      },
      {
        id: "vim",
        label: "Vim editing mode",
        value: onOff(config.vim === true),
        control: {
          type: "boolean",
          current: config.vim === true,
          apply: { kind: "flag", key: "vim" },
        },
        description: "Modal NORMAL/INSERT editing in the composer (also /vim).",
      },
      {
        id: "terminalTitle",
        label: "Dynamic terminal title",
        value: onOff(config.terminalTitle !== false),
        control: {
          type: "boolean",
          current: config.terminalTitle !== false,
          apply: { kind: "flag", key: "terminalTitle" },
        },
        description: "Update the terminal window/tab title with live session state.",
      },
      {
        id: "clipboardMode",
        label: "Clipboard OSC 52 mode",
        value: config.clipboard?.osc52 ?? "auto",
        control: {
          type: "enum",
          options: [...CLIPBOARD_OSC52_MODES],
          current: config.clipboard?.osc52 ?? "auto",
          apply: { kind: "clipboard", key: "osc52" },
        },
        description: "Copy strategy: auto (OSC 52 over SSH) / always (force OSC 52) / never.",
      },
      {
        id: "clipboardMaxBytes",
        label: "Clipboard OSC 52 byte cap",
        value: numStr(config.clipboard?.osc52MaxBytes, DEFAULT_OSC52_MAX_BYTES),
        control: {
          type: "enum",
          options: [...OSC52_MAX_BYTES_OPTIONS],
          current: numStr(config.clipboard?.osc52MaxBytes, DEFAULT_OSC52_MAX_BYTES),
          apply: { kind: "clipboard", key: "osc52MaxBytes" },
        },
        description:
          "Max bytes for an OSC 52 copy (0 = no cap; terminals silently drop huge ones).",
      },
      {
        id: "editor",
        label: "External editor",
        value: editorLabel,
        control: { type: "delegate", command: "/editor" },
        description: "Preferred editor for /open and clickable file paths (blank = auto-detect).",
      },
    ],
  }

  const loggingCfg = resolveCliLoggingConfig(config.logging)
  const logging: SettingsSectionView = {
    id: "logging",
    title: "Logging",
    rows: [
      {
        id: "loggingFileLevel",
        label: "File log level",
        value: loggingCfg.fileLevel,
        control: {
          type: "enum",
          options: [...CLI_LOG_LEVELS],
          current: loggingCfg.fileLevel,
          apply: { kind: "logging", key: "fileLevel" },
        },
        description:
          "Minimum severity persisted to ~/.cognia/logs/mcp.log (the /mcp logs panel always shows everything).",
      },
      {
        id: "loggingMcpLogMaxKb",
        label: "MCP log rotation size (KiB)",
        value: String(loggingCfg.mcpLogMaxKb),
        control: {
          type: "enum",
          options: [...MCP_LOG_MAX_KB_OPTIONS],
          current: String(loggingCfg.mcpLogMaxKb),
          apply: { kind: "logging", key: "mcpLogMaxKb" },
        },
        description: "mcp.log rotates to mcp.log.1 once it exceeds this size.",
      },
      {
        id: "loggingCrashLogMaxKb",
        label: "Crash log rotation size (KiB)",
        value: loggingCfg.crashLogMaxKb === 0 ? "never" : String(loggingCfg.crashLogMaxKb),
        control: {
          type: "enum",
          options: [...CRASH_LOG_MAX_KB_OPTIONS],
          current: String(loggingCfg.crashLogMaxKb),
          apply: { kind: "logging", key: "crashLogMaxKb" },
        },
        description: "crash.log rotates to crash.log.1 once it exceeds this size (0 = never).",
      },
      {
        id: "loggingViewMcpLogs",
        label: "View MCP / sidecar logs…",
        value: "open panel",
        control: { type: "delegate", command: "/mcp logs" },
        description: "Open the in-TUI log panel over the live MCP / sidecar event stream.",
      },
      {
        id: "loggingLogDir",
        label: "Log directory",
        value: "~/.cognia/logs",
        control: { type: "readonly" },
        description: "Where crash.log and mcp.log live on disk.",
      },
    ],
  }

  const advanced: SettingsSectionView = {
    id: "advanced",
    title: "Advanced",
    rows: [
      {
        id: "autoCompact",
        label: "Auto-compact context",
        value: onOff(config.autoCompact !== false),
        control: {
          type: "boolean",
          current: config.autoCompact !== false,
          apply: { kind: "flag", key: "autoCompact" },
        },
        description: "Automatically compact the live context as it nears the model's window.",
      },
      {
        id: "autoCompactThreshold",
        label: "Auto-compact threshold",
        value: numStr(config.autoCompactThreshold, 0.85),
        control: {
          type: "enum",
          options: [...AUTO_COMPACT_THRESHOLD_OPTIONS],
          current: numStr(config.autoCompactThreshold, 0.85),
          apply: { kind: "numberValue", key: "autoCompactThreshold" },
        },
        description:
          "Fraction of the context window that triggers auto-compaction (clamped 0.5–0.98).",
      },
      {
        id: "streamIdleTimeoutMs",
        label: "Stream idle timeout (ms)",
        value: numStr(config.streamIdleTimeoutMs, 60000),
        control: {
          type: "enum",
          options: [...STREAM_IDLE_TIMEOUT_OPTIONS],
          current: numStr(config.streamIdleTimeoutMs, 60000),
          apply: { kind: "numberValue", key: "streamIdleTimeoutMs" },
        },
        description: "Abort a turn if the model stream stalls this long mid-turn (0 = disabled).",
      },
      {
        id: "aiSdkMaxSteps",
        label: "Agent step budget (non-Anthropic)",
        value: numStr(config.aiSdkMaxSteps, 256),
        control: {
          type: "enum",
          options: [...AI_SDK_MAX_STEPS_OPTIONS],
          current: numStr(config.aiSdkMaxSteps, 256),
          apply: { kind: "numberValue", key: "aiSdkMaxSteps" },
        },
        description:
          "Max agentic tool-call legs per turn on OpenAI-compatible providers (runaway backstop).",
      },
      {
        id: "toolExecutionTimeoutMs",
        label: "Read-only tool timeout (ms)",
        value: numStr(config.toolExecutionTimeoutMs, 120000),
        control: {
          type: "enum",
          options: [...TOOL_EXEC_TIMEOUT_OPTIONS],
          current: numStr(config.toolExecutionTimeoutMs, 120000),
          apply: { kind: "numberValue", key: "toolExecutionTimeoutMs" },
        },
        description:
          "Per-tool deadline for read-only tools on non-Anthropic providers (0 = disabled).",
      },
      {
        id: "subagentStreamIdleTimeoutMs",
        label: "Subagent stream idle timeout (ms)",
        value: numStr(config.subagentStreamIdleTimeoutMs, 300000),
        control: {
          type: "enum",
          options: [...SUBAGENT_IDLE_TIMEOUT_OPTIONS],
          current: numStr(config.subagentStreamIdleTimeoutMs, 300000),
          apply: { kind: "numberValue", key: "subagentStreamIdleTimeoutMs" },
        },
        description:
          "Stream-idle timeout for a dispatched subagent turn — far higher than interactive (0 = off).",
      },
      {
        id: "subagentMaxDepth",
        label: "Subagent max nesting depth",
        value: numStr(config.subagentMaxDepth, 2),
        control: {
          type: "enum",
          options: [...SUBAGENT_MAX_DEPTH_OPTIONS],
          current: numStr(config.subagentMaxDepth, 2),
          apply: { kind: "numberValue", key: "subagentMaxDepth" },
        },
        description:
          "How deep dispatch_agent may nest (subagents spawning subagents). 1 = subagents are leaves.",
      },
    ],
  }

  const bindings = resolveKeybindings(config.keybindings)
  const keybindings: SettingsSectionView = {
    id: "keybindings",
    title: "Keybindings",
    rows: [
      ...KEYBINDABLE_ACTIONS.map((action): SettingsRow => ({
        id: `key:${action}`,
        label: KEYBINDING_LABELS[action],
        value: formatKeySpec(bindings[action]),
        control: { type: "readonly" },
        description: "Current binding — change it from Rebind a key… below.",
      })),
      {
        id: "rebind",
        label: "Rebind a key…",
        value: "open editor",
        control: { type: "delegate", command: "/keybind" },
        description: "Open the interactive keybinding editor.",
      },
    ],
  }

  const workspace: SettingsSectionView = {
    id: "workspace",
    title: "Workspace",
    rows: [
      {
        id: "cwd",
        label: "Working dir",
        value: config.cwd,
        control: { type: "readonly" },
        description: "The working directory for this session.",
      },
      {
        id: "additionalRoots",
        label: "Additional roots…",
        value: (config.additionalRoots ?? []).length
          ? `${config.additionalRoots!.length} roots`
          : "none",
        control: { type: "delegate", command: "/add-dir" },
        description: "Extra roots the agent may read without an approval prompt.",
      },
      {
        id: "customLimits",
        label: "Custom limits sources",
        value: (config.customLimitsSources ?? []).length
          ? `${config.customLimitsSources!.length} (edit in config.json)`
          : "none",
        control: { type: "readonly" },
        description: "User-defined usage/limits sources surfaced in /limits (edit in config.json).",
      },
    ],
  }

  return [
    model,
    appearance,
    display,
    tools,
    git,
    behavior,
    terminal,
    logging,
    advanced,
    keybindings,
    workspace,
  ]
}

/** Preset options for the inline result line cap (Display section enum). */
export const RESULT_MAX_LINE_OPTIONS = ["20", "40", "80", "160", "400"] as const
/** Preset options for the large-output pager threshold (Display section enum). */
export const PAGER_THRESHOLD_OPTIONS = ["100", "200", "500", "1000"] as const
/** Preset fractions for the auto-compaction threshold (Advanced section enum). */
export const AUTO_COMPACT_THRESHOLD_OPTIONS = ["0.7", "0.75", "0.8", "0.85", "0.9", "0.95"] as const
/** Preset millisecond options for the interactive stream-idle watchdog. */
export const STREAM_IDLE_TIMEOUT_OPTIONS = ["0", "30000", "60000", "120000", "300000"] as const
/** Preset step-budget options for the non-Anthropic agent loop. */
export const AI_SDK_MAX_STEPS_OPTIONS = ["64", "128", "256", "512", "1024"] as const
/** Preset millisecond options for the read-only tool-execution deadline. */
export const TOOL_EXEC_TIMEOUT_OPTIONS = ["0", "30000", "60000", "120000", "300000"] as const
/** Preset millisecond options for the dispatched-subagent stream-idle watchdog. */
export const SUBAGENT_IDLE_TIMEOUT_OPTIONS = ["0", "120000", "300000", "600000"] as const

/** Nesting-depth choices for `dispatch_agent` (1 = subagents are leaves). */
export const SUBAGENT_MAX_DEPTH_OPTIONS = ["1", "2", "3", "4"] as const
/** Preset byte-cap options for the OSC 52 clipboard escape (`0` disables the cap). */
export const OSC52_MAX_BYTES_OPTIONS = ["0", "65536", "74994", "131072", "262144"] as const
/** Preset rotation sizes (KiB) for mcp.log. */
export const MCP_LOG_MAX_KB_OPTIONS = ["512", "1024", "2048", "4096", "8192"] as const
/** Preset rotation sizes (KiB) for crash.log (`0` = never rotate). */
export const CRASH_LOG_MAX_KB_OPTIONS = ["0", "256", "512", "1024", "4096"] as const

/** Render-pref keys that hold a number (vs. a boolean) — drives App's apply parse. */
export const NUMERIC_RENDER_KEYS: ReadonlySet<keyof ResolvedRenderConfig> = new Set([
  "toolResultMaxLines",
  "pagerThresholdLines",
])

/** Default value of every top-level boolean flag (absent-key semantics). Drives
 * both reset-to-default and any code that needs a flag's product default. */
const FLAG_DEFAULTS: Record<BooleanFlagKey, boolean> = {
  webTools: true,
  autoRoute: false,
  skillTool: false,
  slashCommandTool: false,
  externalSkills: true,
  pluginTools: false,
  notify: false,
  desktopNotifications: true,
  autoCompact: true,
  showActiveSkills: false,
  terminalTitle: true,
  vim: false,
}

/** Default value of every top-level numeric knob (matches the schema fallbacks). */
const NUMBER_DEFAULTS: Record<NumberConfigKey, number> = {
  autoCompactThreshold: 0.85,
  streamIdleTimeoutMs: 60_000,
  aiSdkMaxSteps: 256,
  toolExecutionTimeoutMs: 120_000,
  subagentStreamIdleTimeoutMs: 300_000,
  subagentMaxDepth: 2,
}

/** Default for the scalar `configValue` keys the panel edits (only skillLoadMode today). */
const CONFIG_VALUE_DEFAULTS: Partial<Record<SettableKey, string>> = {
  skillLoadMode: "name",
}

/**
 * The product default for a settings row's {@link SettingsApplyTarget} — what
 * "reset to default" should write. Returns a string (enum/number) or boolean to
 * match the row's control, or `undefined` for a target with no meaningful default
 * (delegate/form/readonly rows are never reset). The value is fed straight back
 * through `App.applySettings(target, default)`, so it must match `applySettings`'s
 * expected value type for that kind.
 */
export function applyTargetDefault(target: SettingsApplyTarget): string | boolean | undefined {
  switch (target.kind) {
    case "theme":
      return DEFAULT_THEME_NAME
    case "outputStyle":
      return "default"
    case "statusTheme":
      return "default"
    case "mascotEnabled":
      return true
    case "mascotStyle":
      return "clawd"
    case "flag":
      return FLAG_DEFAULTS[target.key]
    case "configValue":
      return CONFIG_VALUE_DEFAULTS[target.key]
    case "numberValue":
      return String(NUMBER_DEFAULTS[target.key])
    case "clipboard":
      return target.key === "osc52" ? "auto" : String(DEFAULT_OSC52_MAX_BYTES)
    case "builtinTool":
      return DEFAULT_BUILTIN_TOOLS[target.key] ?? false
    case "gitWorkflow":
      // Both git booleans (co-author trailer / PR footer) default to on.
      return true
    case "logging":
      return String(CLI_LOGGING_DEFAULTS[target.key])
    case "hook":
      return BUILTIN_HOOKS.find((h) => h.id === target.id)?.defaultEnabled ?? false
    case "render":
      return NUMERIC_RENDER_KEYS.has(target.key)
        ? String(RENDER_DEFAULTS[target.key])
        : (RENDER_DEFAULTS[target.key] as boolean)
  }
}

/** The next value when cycling an enum row by `delta` (wraps). */
export function cycleEnum(options: string[], current: string, delta: number): string {
  if (options.length === 0) return current
  const at = options.indexOf(current)
  const from = at < 0 ? 0 : at
  const next = (((from + delta) % options.length) + options.length) % options.length
  return options[next]
}
