/**
 * Writer for `~/.cognia/config.json` (the non-secret user config). Backs
 * `cognia-agent config set`. Validates the merged result against the schema so
 * a bad value is rejected before it lands on disk. Injectable fs for tests.
 */

import fs from "node:fs"
import path from "node:path"

import {
  cliConfigFileSchema,
  type CliConfigFile,
  type CliLoggingConfig,
  type ClipboardConfig,
  type EditorConfig,
  type GitWorkflowConfig,
  type MascotConfig,
  type RenderConfig,
  type StatusBarConfig,
  type SubagentModelOverride,
} from "./schema"
import { userConfigPath, type FileReader } from "./load"
import type { BuiltinToolsConfig } from "@/lib/claude/types"

export interface ConfigMutateFs {
  read: FileReader
  write: (absPath: string, content: string) => void
  mkdirp: (dir: string) => void
}

export const realConfigMutateFs: ConfigMutateFs = {
  read: (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
      throw err
    }
  },
  write: (p, content) => fs.writeFileSync(p, content),
  mkdirp: (dir) => fs.mkdirSync(dir, { recursive: true }),
}

/** Top-level scalar keys editable via `config set`. */
export const SETTABLE_KEYS = [
  "provider",
  "model",
  "systemPrompt",
  "permissionMode",
  "cwd",
  "thinkingLevel",
  "outputStyle",
  "agentMode",
  "theme",
  "skillLoadMode",
] as const
export type SettableKey = (typeof SETTABLE_KEYS)[number]

function readUserConfig(home: string, fsx: ConfigMutateFs): CliConfigFile {
  const raw = fsx.read(userConfigPath(home))
  if (raw === null) return {}
  return cliConfigFileSchema.parse(JSON.parse(raw))
}

/**
 * Set one top-level scalar key in config.json, validating the merged file.
 * Returns the absolute path written.
 */
export function setConfigValue(
  home: string,
  key: string,
  value: string,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  if (!(SETTABLE_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown config key "${key}" — settable: ${SETTABLE_KEYS.join(", ")}`)
  }
  const current = readUserConfig(home, fsx)
  const merged = cliConfigFileSchema.parse({ ...current, [key]: value })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Remember a model for a SPECIFIC provider in `config.json`
 * (`providers[providerId].model`). This is the per-provider memory that lets
 * each provider reuse its own last-selected model and stops a single global
 * `model` pin from bleeding across providers. It also CLEARS any legacy
 * top-level `model` key, so an old global pin can't keep shadowing the
 * per-provider value. Validates the merged file before writing; returns the
 * absolute path written.
 */
export function setProviderModel(
  home: string,
  providerId: string,
  modelId: string,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  // Drop the legacy global `model` pin while promoting the per-provider value.
  const { model: _legacyTopLevelModel, ...rest } = current
  const providers = {
    ...rest.providers,
    [providerId]: { ...rest.providers?.[providerId], model: modelId },
  }
  const merged = cliConfigFileSchema.parse({ ...rest, providers })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Set (or clear) a provider's base URL in `config.json`'s
 * `providers[providerId].baseURL` — the per-provider proxy/self-hosted/
 * regional endpoint override. Only `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL`
 * get an env-var shortcut; every other provider previously required hand-
 * editing `config.json` even though the schema field already validated fine.
 * Passing `null` clears the override (falls back to the catalog default).
 * Validates the merged file before writing; returns the absolute path.
 */
export function setProviderBaseURL(
  home: string,
  providerId: string,
  baseURL: string | null,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  if (!providerId.trim()) throw new Error("provider id is required")
  const current = readUserConfig(home, fsx)
  const providers = { ...current.providers }
  const existing = providers[providerId] ?? {}
  if (baseURL === null) {
    const { baseURL: _dropped, ...rest } = existing
    providers[providerId] = rest
  } else {
    providers[providerId] = { ...existing, baseURL }
  }
  const merged = cliConfigFileSchema.parse({ ...current, providers })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Merge a status-bar patch into `config.json`'s `statusBar` object (the footer
 * isn't a scalar so it can't go through {@link setConfigValue}). Validates the
 * merged file before writing. Returns the absolute path written.
 */
export function setStatusBarConfig(
  home: string,
  patch: StatusBarConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const statusBar = { ...current.statusBar, ...patch }
  const merged = cliConfigFileSchema.parse({ ...current, statusBar })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Merge a mascot patch into `config.json`'s `mascot` object (same shape as
 * {@link setStatusBarConfig} — an object, not a scalar). Validates the merged
 * file before writing. Returns the absolute path written.
 */
export function setMascotConfig(
  home: string,
  patch: MascotConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const mascot = { ...current.mascot, ...patch }
  const merged = cliConfigFileSchema.parse({ ...current, mascot })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Merge an editor patch into `config.json`'s `editor` object. The stored value
 * may be the string sugar (`"code"`) — normalize it to the object form before
 * merging so a partial patch (e.g. just `{ command }` from `/editor code`) never
 * clobbers existing `args`/`gotoFormat`. Validates before writing.
 */
export function setEditorConfig(
  home: string,
  patch: EditorConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const prior: EditorConfig =
    typeof current.editor === "string" ? { command: current.editor } : (current.editor ?? {})
  const editor = { ...prior, ...patch }
  const merged = cliConfigFileSchema.parse({ ...current, editor })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Merge a render-prefs patch into `config.json`'s `render` object (same object
 * shape as {@link setStatusBarConfig}). Validates the merged file before
 * writing. Returns the absolute path written.
 */
export function setRenderConfig(
  home: string,
  patch: RenderConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const render = { ...current.render, ...patch }
  const merged = cliConfigFileSchema.parse({ ...current, render })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Merge a keybindings patch into `config.json`'s `keybindings` map (action id →
 * key spec). A `null` value for a key DELETES that override (reset to default).
 * Validates the merged file before writing. Returns the absolute path written.
 */
export function setKeybindings(
  home: string,
  patch: Record<string, string | null>,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const keybindings: Record<string, string> = { ...current.keybindings }
  for (const [id, spec] of Object.entries(patch)) {
    if (spec === null) delete keybindings[id]
    else keybindings[id] = spec
  }
  const next = Object.keys(keybindings).length > 0 ? keybindings : undefined
  const merged = cliConfigFileSchema.parse({ ...current, keybindings: next })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Replace `config.json`'s `additionalRoots` array (the `/add-dir` extra working
 * roots). An array, not a scalar, so it can't go through {@link setConfigValue}.
 * Writes the array verbatim (the controller dedupes/validates first); an empty
 * array clears the key. Validates the merged file; returns the path written.
 */
export function setAdditionalRoots(
  home: string,
  roots: string[],
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const merged = cliConfigFileSchema.parse({
    ...current,
    additionalRoots: roots.length > 0 ? roots : undefined,
  })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/**
 * Set the boolean `pluginTools` gate in `config.json`. A dedicated writer (not
 * {@link setConfigValue}) because that one only handles string scalars. Used by
 * the effort slider to couple the `"ultracode"` tier to the in-tree
 * dynamic-workflow plugin tools. Validates the merged file; returns the path.
 */
export function setPluginToolsConfig(
  home: string,
  enabled: boolean,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const merged = cliConfigFileSchema.parse({ ...current, pluginTools: enabled })
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(merged, null, 2) + "\n")
  return target
}

/** Shared writer: validate the merged config and write it, returning the path. */
function writeMergedConfig(home: string, merged: CliConfigFile, fsx: ConfigMutateFs): string {
  const validated = cliConfigFileSchema.parse(merged)
  const target = userConfigPath(home)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(validated, null, 2) + "\n")
  return target
}

/**
 * Merge a `builtinTools` patch (per-tool boolean toggles) into `config.json`.
 * An object, not a scalar, so it can't go through {@link setConfigValue}. The
 * schema's `.strict()` rejects unknown tool keys before anything is written.
 */
export function setBuiltinTools(
  home: string,
  patch: Partial<BuiltinToolsConfig>,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const builtinTools = { ...current.builtinTools, ...patch }
  return writeMergedConfig(home, { ...current, builtinTools }, fsx)
}

/** Top-level boolean flags editable from the settings panel. */
export const BOOLEAN_FLAG_KEYS = [
  "webTools",
  "autoRoute",
  "skillTool",
  "slashCommandTool",
  "externalSkills",
  "pluginTools",
  "notify",
  "desktopNotifications",
  "autoCompact",
  "showActiveSkills",
  "terminalTitle",
  "vim",
] as const
export type BooleanFlagKey = (typeof BOOLEAN_FLAG_KEYS)[number]

/**
 * Set one top-level boolean flag in `config.json` (the dormant `webTools` /
 * `skillTool` / `slashCommandTool` / `externalSkills` toggles that previously
 * could only be edited by hand). {@link setConfigValue} only handles strings.
 */
export function setBooleanFlag(
  home: string,
  key: BooleanFlagKey,
  value: boolean,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  if (!(BOOLEAN_FLAG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown boolean flag "${key}" — settable: ${BOOLEAN_FLAG_KEYS.join(", ")}`)
  }
  const current = readUserConfig(home, fsx)
  return writeMergedConfig(home, { ...current, [key]: value }, fsx)
}

/**
 * Top-level NUMERIC config keys editable from the settings panel — the reliability
 * / context-management knobs that {@link setConfigValue} (strings only) and
 * {@link setBooleanFlag} (booleans only) can't reach. `autoCompactThreshold` is a
 * 0–1 fraction; the rest are millisecond / step counts. Values are validated
 * against the schema (min/int constraints) before anything lands on disk.
 */
export const NUMBER_CONFIG_KEYS = [
  "autoCompactThreshold",
  "streamIdleTimeoutMs",
  "aiSdkMaxSteps",
  "toolExecutionTimeoutMs",
  "subagentStreamIdleTimeoutMs",
  "subagentMaxDepth",
] as const
export type NumberConfigKey = (typeof NUMBER_CONFIG_KEYS)[number]

/**
 * Set one top-level numeric config key in `config.json`. A dedicated writer (not
 * {@link setConfigValue}, which coerces everything to a string) so the schema's
 * numeric constraints validate the merged file before writing. Returns the path.
 */
export function setNumberConfig(
  home: string,
  key: NumberConfigKey,
  value: number,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  if (!(NUMBER_CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown numeric key "${key}" — settable: ${NUMBER_CONFIG_KEYS.join(", ")}`)
  }
  const current = readUserConfig(home, fsx)
  return writeMergedConfig(home, { ...current, [key]: value }, fsx)
}

/**
 * Merge a clipboard patch into `config.json`'s `clipboard` object (OSC 52 mode +
 * byte cap). An object, not a scalar, so it can't go through {@link
 * setConfigValue}; validated by the schema before writing. Returns the path.
 */
export function setClipboardConfig(
  home: string,
  patch: ClipboardConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const clipboard = { ...current.clipboard, ...patch }
  return writeMergedConfig(home, { ...current, clipboard }, fsx)
}

/**
 * Merge a git dev-workflow patch into `config.json`'s `git` object (protected
 * branches / co-author trailer / PR footer / base branch). Same shape as
 * {@link setClipboardConfig}; a key explicitly set to `undefined` in the patch
 * clears it back to its default. Returns the path.
 */
export function setGitWorkflowConfig(
  home: string,
  patch: GitWorkflowConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const git = { ...current.git, ...patch }
  // Drop cleared keys so the file stays sparse (defaults resolve at read time).
  for (const k of Object.keys(git) as (keyof GitWorkflowConfig)[]) {
    if (git[k] === undefined) delete git[k]
  }
  return writeMergedConfig(home, { ...current, git: Object.keys(git).length ? git : undefined }, fsx)
}

/**
 * Merge a logging-preferences patch into `config.json`'s `logging` object
 * (mcp.log file level / rotation size, crash.log rotation). Same shape as
 * {@link setClipboardConfig}; a key explicitly set to `undefined` in the patch
 * clears it back to its default. Returns the path.
 */
export function setLoggingConfig(
  home: string,
  patch: CliLoggingConfig,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const logging = { ...current.logging, ...patch }
  for (const k of Object.keys(logging) as (keyof CliLoggingConfig)[]) {
    if (logging[k] === undefined) delete logging[k]
  }
  return writeMergedConfig(
    home,
    { ...current, logging: Object.keys(logging).length ? logging : undefined },
    fsx
  )
}

/** Top-level string-array keys editable from the settings panel. */
export const ARRAY_CONFIG_KEYS = ["skillDirs", "allowedTools", "additionalRoots"] as const
export type ArrayConfigKey = (typeof ARRAY_CONFIG_KEYS)[number]

/**
 * Replace one top-level string-array key in `config.json` (`skillDirs` /
 * `allowedTools` / `additionalRoots`). An empty array clears the key (so an
 * empty `allowedTools` means "all tools", not "no tools"). The caller dedupes /
 * validates the entries first.
 */
export function setStringArrayConfig(
  home: string,
  key: ArrayConfigKey,
  values: string[],
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  if (!(ARRAY_CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`unknown array key "${key}" — settable: ${ARRAY_CONFIG_KEYS.join(", ")}`)
  }
  const current = readUserConfig(home, fsx)
  return writeMergedConfig(home, { ...current, [key]: values.length > 0 ? values : undefined }, fsx)
}

/**
 * Merge one built-in-hook enable/disable override into `config.json`'s
 * `builtinHookOverrides` map (id → boolean). Absent ids fall back to each
 * hook's `defaultEnabled`, so this only records explicit user choices.
 */
export function setBuiltinHookOverride(
  home: string,
  id: string,
  enabled: boolean,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const current = readUserConfig(home, fsx)
  const builtinHookOverrides = { ...current.builtinHookOverrides, [id]: enabled }
  return writeMergedConfig(home, { ...current, builtinHookOverrides }, fsx)
}

/**
 * Set (or clear) one subagent's provider/model override in `config.json`'s
 * `subagentModels` map (subagent id → override). Passing `null` DELETES that
 * subagent's entry (reset to inherit). An object, not a scalar, so it can't go
 * through {@link setConfigValue}; the schema's `.strict()` + the override's
 * `.refine()` reject a malformed/empty override before anything is written.
 * Returns the absolute path written.
 */
export function setSubagentModel(
  home: string,
  agentId: string,
  override: SubagentModelOverride | null,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  if (!agentId.trim()) throw new Error("subagent id is required")
  const current = readUserConfig(home, fsx)
  const subagentModels: Record<string, SubagentModelOverride> = { ...current.subagentModels }
  if (override === null) delete subagentModels[agentId]
  else subagentModels[agentId] = override
  const next = Object.keys(subagentModels).length > 0 ? subagentModels : undefined
  return writeMergedConfig(home, { ...current, subagentModels: next }, fsx)
}

/** A user-authored custom theme file: a base (built-in name or BaseColors
 * object) plus optional per-token colour overrides. Mirrors the shape
 * `tui/theme/resolve.ts:readCogniaCustomTheme` reads back. */
export interface CustomThemePayload {
  base: string | Record<string, string>
  overrides?: Record<string, string>
}

/** Absolute path of a custom theme file: `<home>/themes/<slug>.json`. */
export function customThemePath(home: string, slug: string): string {
  return path.join(home, "themes", `${slug}.json`)
}

/**
 * Write a custom theme to `<home>/themes/<slug>.json` (NOT config.json — this is
 * a standalone theme file resolved via `theme: "custom:<slug>"`). The caller
 * activates it separately with `setConfigValue(home, "theme", "custom:<slug>")`.
 * An empty `overrides` object is omitted to keep the file minimal. Returns the
 * theme file path written.
 */
export function setCustomTheme(
  home: string,
  slug: string,
  payload: CustomThemePayload,
  fsx: ConfigMutateFs = realConfigMutateFs
): string {
  const body: CustomThemePayload = { base: payload.base }
  if (payload.overrides && Object.keys(payload.overrides).length > 0) {
    body.overrides = payload.overrides
  }
  const target = customThemePath(home, slug)
  fsx.mkdirp(path.dirname(target))
  fsx.write(target, JSON.stringify(body, null, 2) + "\n")
  return target
}
