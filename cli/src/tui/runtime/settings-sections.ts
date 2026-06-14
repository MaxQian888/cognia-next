/**
 * Pure model for the unified `/settings` panel — the single aggregated entry
 * point that replaces the scattered `/model`, `/theme`, `/statusbar`, … commands
 * and surfaces the previously file-only config knobs (`builtinTools`, `webTools`,
 * `skillDirs`, hook overrides, system prompt, …).
 *
 * This module owns NO UI and NO persistence: it turns a {@link ResolvedConfig}
 * into a list of sections → rows → controls. The `SettingsOverlay` component
 * renders it; `App.tsx` interprets a row's {@link SettingsControl} into the
 * EXISTING overlays / commands / `mutate.ts` helpers. Keeping it pure means the
 * whole panel structure is unit-testable without rendering.
 */
import {
  MASCOT_STYLES,
  OUTPUT_STYLES,
  STATUS_THEMES,
  type ResolvedConfig,
} from "../../config/schema"
import type { BuiltinToolsConfig } from "@/lib/claude/types"
import { DEFAULT_BUILTIN_TOOLS } from "@/lib/claude/types"
import { BUILTIN_HOOKS } from "@/lib/claude/hooks/builtin-hooks"
import { THEME_CHOICES } from "../theme/resolve"
import type { BooleanFlagKey } from "../../config/mutate"

export type SettingsSectionId = "model" | "appearance" | "tools" | "behavior" | "workspace"

/** Identifies what a row's chosen value persists/applies to. App maps each to an
 * existing reducer action + `mutate.ts` helper. */
export type SettingsApplyTarget =
  | { kind: "theme" }
  | { kind: "outputStyle" }
  | { kind: "statusTheme" }
  | { kind: "mascotEnabled" }
  | { kind: "mascotStyle" }
  | { kind: "flag"; key: BooleanFlagKey }
  | { kind: "builtinTool"; key: keyof BuiltinToolsConfig }
  | { kind: "hook"; id: string }

/** A single-field editor the App opens via FormOverlay / a dedicated command. */
export type SettingsFormField = "systemPrompt" | "skillDirs" | "allowedTools" | "customTheme"

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

/** Friendly labels for the builtin-tools toggles, in schema order. */
const BUILTIN_TOOL_ROWS: { key: keyof BuiltinToolsConfig; label: string }[] = [
  { key: "fileExtras", label: "File extras (hash/diff/search)" },
  { key: "coreFiles", label: "Core file tools" },
  { key: "coreFilesOnAnthropic", label: "Core files on Anthropic" },
  { key: "git", label: "Git tools" },
  { key: "process", label: "Process tools" },
  { key: "environment", label: "Environment tools" },
  { key: "shellAdvanced", label: "Advanced shell" },
  { key: "terminalRepl", label: "Terminal REPL" },
  { key: "lsp", label: "LSP code intelligence" },
]

/**
 * Build the full settings panel model from the resolved config. Every section is
 * always present (stable order) so the panel layout is deterministic.
 */
export function settingsSections(config: ResolvedConfig): SettingsSectionView[] {
  const mascotEnabled = config.mascot?.enabled !== false
  const statusTheme = config.statusBar?.theme ?? "default"

  const model: SettingsSectionView = {
    id: "model",
    title: "Model & Reasoning",
    rows: [
      {
        id: "provider",
        label: "Provider",
        value: config.provider,
        control: { type: "delegate", command: "/provider" },
      },
      {
        id: "model",
        label: "Model",
        value: config.model ?? "default",
        control: { type: "delegate", command: "/model" },
      },
      {
        id: "mode",
        label: "Permission mode",
        value: config.permissionMode,
        control: { type: "delegate", command: "/mode" },
      },
      {
        id: "thinking",
        label: "Thinking level",
        value: config.thinkingLevel ?? "off",
        control: { type: "delegate", command: "/think" },
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
        value: config.theme ?? "classic",
        control: {
          type: "enum",
          options: [...THEME_CHOICES],
          current: config.theme ?? "classic",
          apply: { kind: "theme" },
        },
      },
      {
        id: "custom-theme",
        label: "Custom theme colours…",
        value: (config.theme ?? "").startsWith("custom:") ? config.theme! : "edit base colours",
        control: { type: "form", field: "customTheme" },
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
      },
      {
        id: "status-segments",
        label: "Status bar segments…",
        value: (config.statusBar?.segments ?? []).join(" ") || "default",
        control: { type: "delegate", command: "/statusbar" },
      },
      {
        id: "mascot-enabled",
        label: "Mascot",
        value: onOff(mascotEnabled),
        control: { type: "boolean", current: mascotEnabled, apply: { kind: "mascotEnabled" } },
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
      },
      {
        id: "skillDirs",
        label: "Extra skill dirs…",
        value: (config.skillDirs ?? []).length ? `${config.skillDirs!.length} dirs` : "none",
        control: { type: "form", field: "skillDirs" },
      },
      {
        id: "allowedTools",
        label: "Allowed tools allowlist…",
        value: (config.allowedTools ?? []).length ? `${config.allowedTools!.length} tools` : "all",
        control: { type: "form", field: "allowedTools" },
      },
      ...BUILTIN_TOOL_ROWS.map(
        (t): SettingsRow => ({
          id: `tool:${t.key}`,
          label: t.label,
          value: onOff(toolValue(config, t.key)),
          control: {
            type: "boolean",
            current: toolValue(config, t.key),
            apply: { kind: "builtinTool", key: t.key },
          },
        })
      ),
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
      },
      ...BUILTIN_HOOKS.map((h): SettingsRow => {
        const enabled = config.builtinHookOverrides?.[h.id] ?? h.defaultEnabled
        return {
          id: `hook:${h.id}`,
          label: `Hook: ${h.id}`,
          value: onOff(enabled),
          control: { type: "boolean", current: enabled, apply: { kind: "hook", id: h.id } },
        }
      }),
    ],
  }

  const workspace: SettingsSectionView = {
    id: "workspace",
    title: "Workspace",
    rows: [
      { id: "cwd", label: "Working dir", value: config.cwd, control: { type: "readonly" } },
      {
        id: "additionalRoots",
        label: "Additional roots…",
        value: (config.additionalRoots ?? []).length
          ? `${config.additionalRoots!.length} roots`
          : "none",
        control: { type: "delegate", command: "/add-dir" },
      },
    ],
  }

  return [model, appearance, tools, behavior, workspace]
}

/** The next value when cycling an enum row by `delta` (wraps). */
export function cycleEnum(options: string[], current: string, delta: number): string {
  if (options.length === 0) return current
  const at = options.indexOf(current)
  const from = at < 0 ? 0 : at
  const next = (((from + delta) % options.length) + options.length) % options.length
  return options[next]
}
