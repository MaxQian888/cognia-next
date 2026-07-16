/**
 * Layered CLI config loader.
 *
 * Precedence (low → high, later wins):
 *   1. defaults ({@link DEFAULT_RESOLVED_CONFIG})
 *   2. user      `~/.cognia/config.json`
 *   3. credentials `~/.cognia/credentials.json` (api keys only)
 *   4. project   `./.cognia/config.json`
 *   5. env vars  (ANTHROPIC_API_KEY, COGNIA_PROVIDER, …)
 *   6. CLI flags (passed by the command parser)
 *
 * The core `resolveConfig()` is pure: every input (home dir, cwd, env, flags,
 * file reader) is injected, so it unit-tests without touching real disk.
 * `loadConfig()` wires the real fs + `os.homedir()` on top.
 */

import os from "node:os"
import path from "node:path"
import fs from "node:fs"

import {
  cliConfigFileSchema,
  credentialsFileSchema,
  DEFAULT_RESOLVED_CONFIG,
  type CliConfigFile,
  type CredentialsFile,
  type EditorConfig,
  type ProviderConfig,
  type ResolvedConfig,
} from "./schema"

/** Reads a file's text, or returns `null` when it does not exist. */
export type FileReader = (absPath: string) => string | null

export interface ResolveConfigInput {
  /** CLI home directory (holds config.json + credentials.json). */
  home: string
  /** Working directory — also where `./.cognia/config.json` is looked up. */
  cwd: string
  /** Process environment. */
  env: Record<string, string | undefined>
  /** Overrides from parsed CLI flags (highest precedence). */
  flags?: Partial<CliConfigFile>
  /** Injected reader; defaults to real fs in {@link loadConfig}. */
  readFile: FileReader
}

/** Maps a well-known provider-key env var to its provider id. */
const ENV_API_KEY_TO_PROVIDER: Record<string, string> = {
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GOOGLE_GENERATIVE_AI_API_KEY: "google",
  GEMINI_API_KEY: "google",
  MISTRAL_API_KEY: "mistral",
  COHERE_API_KEY: "cohere",
  GROQ_API_KEY: "groq",
  DEEPSEEK_API_KEY: "deepseek",
  OPENROUTER_API_KEY: "openrouter",
}

/** Maps a base-URL env var to its provider id. */
const ENV_BASE_URL_TO_PROVIDER: Record<string, string> = {
  ANTHROPIC_BASE_URL: "anthropic",
  OPENAI_BASE_URL: "openai",
}

export const CONFIG_FILE_NAME = "config.json"
export const CREDENTIALS_FILE_NAME = "credentials.json"
export const PROJECT_CONFIG_DIR = ".cognia"

/** Absolute path to the user config file for a given home dir. */
export function userConfigPath(home: string): string {
  return path.join(home, CONFIG_FILE_NAME)
}

/** Absolute path to the credentials file for a given home dir. */
export function credentialsPath(home: string): string {
  return path.join(home, CREDENTIALS_FILE_NAME)
}

/** Absolute path to the project-local config for a given cwd. */
export function projectConfigPath(cwd: string): string {
  return path.join(cwd, PROJECT_CONFIG_DIR, CONFIG_FILE_NAME)
}

/** The default CLI home: `$COGNIA_HOME` or `~/.cognia`. */
export function resolveHome(env: Record<string, string | undefined>, homedir: string): string {
  const override = env.COGNIA_HOME?.trim()
  if (override) return override
  return path.join(homedir, ".cognia")
}

function parseJsonFile<T>(
  raw: string | null,
  schema: { parse: (v: unknown) => T },
  label: string
): T | null {
  if (raw === null) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`${label}: invalid JSON — ${(err as Error).message}`)
  }
  try {
    return schema.parse(json)
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`)
  }
}

/** Merge provider records field-by-field; `over` wins per field, never wipes. */
function mergeProviders(
  base: Record<string, ProviderConfig>,
  over: Record<string, ProviderConfig> | undefined
): Record<string, ProviderConfig> {
  if (!over) return base
  const out: Record<string, ProviderConfig> = { ...base }
  for (const [id, entry] of Object.entries(over)) {
    out[id] = { ...(out[id] ?? {}), ...stripUndefined(entry) }
  }
  return out
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out = {} as T
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Normalize the `editor` field (string sugar → `{ command }`) and merge it onto
 * the accumulated value. Absent in this layer ⇒ keep the previous value. */
function normalizeEditor(
  layer: CliConfigFile["editor"],
  prev: EditorConfig | undefined
): EditorConfig | undefined {
  if (layer === undefined) return prev
  const next: EditorConfig = typeof layer === "string" ? { command: layer } : layer
  return { ...prev, ...stripUndefined(next) }
}

/** Apply a config layer (file/flags) onto an accumulator. */
function applyLayer(acc: ResolvedConfig, layer: CliConfigFile | undefined): ResolvedConfig {
  if (!layer) return acc
  return {
    provider: layer.provider ?? acc.provider,
    model: layer.model ?? acc.model,
    systemPrompt: layer.systemPrompt ?? acc.systemPrompt,
    permissionMode: layer.permissionMode ?? acc.permissionMode,
    allowedTools: layer.allowedTools ?? acc.allowedTools,
    builtinTools: layer.builtinTools
      ? { ...acc.builtinTools, ...stripUndefined(layer.builtinTools) }
      : acc.builtinTools,
    providers: mergeProviders(acc.providers, layer.providers),
    cwd: layer.cwd ?? acc.cwd,
    pluginTools: layer.pluginTools ?? acc.pluginTools,
    devPlugins: layer.devPlugins ?? acc.devPlugins,
    devPluginsDir: layer.devPluginsDir ?? acc.devPluginsDir,
    webTools: layer.webTools ?? acc.webTools,
    skillTool: layer.skillTool ?? acc.skillTool,
    slashCommandTool: layer.slashCommandTool ?? acc.slashCommandTool,
    subagentModels: layer.subagentModels
      ? { ...acc.subagentModels, ...layer.subagentModels }
      : acc.subagentModels,
    statusBar: layer.statusBar
      ? { ...acc.statusBar, ...stripUndefined(layer.statusBar) }
      : acc.statusBar,
    mascot: layer.mascot ? { ...acc.mascot, ...stripUndefined(layer.mascot) } : acc.mascot,
    twin: layer.twin ? { ...acc.twin, ...stripUndefined(layer.twin) } : acc.twin,
    outputStyle: layer.outputStyle ?? acc.outputStyle,
    thinkingLevel: layer.thinkingLevel ?? acc.thinkingLevel,
    agentMode: layer.agentMode ?? acc.agentMode,
    skillDirs: layer.skillDirs ?? acc.skillDirs,
    additionalRoots: layer.additionalRoots ?? acc.additionalRoots,
    builtinHookOverrides: layer.builtinHookOverrides
      ? { ...acc.builtinHookOverrides, ...layer.builtinHookOverrides }
      : acc.builtinHookOverrides,
    externalSkills: layer.externalSkills ?? acc.externalSkills,
    skillLoadMode: layer.skillLoadMode ?? acc.skillLoadMode,
    showActiveSkills: layer.showActiveSkills ?? acc.showActiveSkills,
    autoCompact: layer.autoCompact ?? acc.autoCompact,
    autoCompactThreshold: layer.autoCompactThreshold ?? acc.autoCompactThreshold,
    theme: layer.theme ?? acc.theme,
    customLimitsSources: layer.customLimitsSources ?? acc.customLimitsSources,
    render: layer.render ? { ...acc.render, ...stripUndefined(layer.render) } : acc.render,
    git: layer.git ? { ...acc.git, ...stripUndefined(layer.git) } : acc.git,
    keybindings: layer.keybindings ? { ...acc.keybindings, ...layer.keybindings } : acc.keybindings,
    layout: layer.layout ?? acc.layout,
    mouse: layer.mouse ?? acc.mouse,
    vim: layer.vim ?? acc.vim,
    terminalTitle: layer.terminalTitle ?? acc.terminalTitle,
    notify: layer.notify ?? acc.notify,
    desktopNotifications: layer.desktopNotifications ?? acc.desktopNotifications,
    clipboard: layer.clipboard
      ? { ...acc.clipboard, ...stripUndefined(layer.clipboard) }
      : acc.clipboard,
    logging: layer.logging ? { ...acc.logging, ...stripUndefined(layer.logging) } : acc.logging,
    editor: normalizeEditor(layer.editor, acc.editor),
    notices: layer.notices ? { ...acc.notices, ...stripUndefined(layer.notices) } : acc.notices,
    streamIdleTimeoutMs: layer.streamIdleTimeoutMs ?? acc.streamIdleTimeoutMs,
    aiSdkMaxSteps: layer.aiSdkMaxSteps ?? acc.aiSdkMaxSteps,
    toolExecutionTimeoutMs: layer.toolExecutionTimeoutMs ?? acc.toolExecutionTimeoutMs,
    subagentStreamIdleTimeoutMs:
      layer.subagentStreamIdleTimeoutMs ?? acc.subagentStreamIdleTimeoutMs,
    subagentMaxDepth: layer.subagentMaxDepth ?? acc.subagentMaxDepth,
    agentBackend: layer.agentBackend ?? acc.agentBackend,
  }
}

/** Overlay credentials.json secrets (api key + subscription token) onto providers. */
function applyCredentials(acc: ResolvedConfig, creds: CredentialsFile | null): ResolvedConfig {
  if (!creds?.providers) return acc
  const providers = { ...acc.providers }
  for (const [id, secret] of Object.entries(creds.providers)) {
    providers[id] = {
      ...(providers[id] ?? {}),
      ...(secret.apiKey ? { apiKey: secret.apiKey } : {}),
      ...(secret.authToken ? { authToken: secret.authToken } : {}),
    }
  }
  return { ...acc, providers }
}

/** Build a config layer from environment variables. */
function envLayer(env: Record<string, string | undefined>): CliConfigFile {
  const providers: Record<string, ProviderConfig> = {}
  for (const [varName, providerId] of Object.entries(ENV_API_KEY_TO_PROVIDER)) {
    const key = env[varName]?.trim()
    if (key) providers[providerId] = { ...(providers[providerId] ?? {}), apiKey: key }
  }
  for (const [varName, providerId] of Object.entries(ENV_BASE_URL_TO_PROVIDER)) {
    const url = env[varName]?.trim()
    if (url) providers[providerId] = { ...(providers[providerId] ?? {}), baseURL: url }
  }
  // Claude Pro/Max subscription token — native-Anthropic auth without an API key.
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim()
  if (oauthToken) providers.anthropic = { ...(providers.anthropic ?? {}), authToken: oauthToken }
  const layer: CliConfigFile = {}
  if (Object.keys(providers).length) layer.providers = providers

  const provider = env.COGNIA_PROVIDER?.trim()
  if (provider) layer.provider = provider
  const model = env.COGNIA_MODEL?.trim()
  if (model) layer.model = model

  // Extra skill dirs (path-list, split on the OS path delimiter) + the
  // external-skill-reuse toggle. `COGNIA_EXTERNAL_SKILLS=0|false|no|off` opts
  // out of reusing Claude Code / Codex / OpenCode dirs; any other value opts in.
  const skillDirs = env.COGNIA_SKILL_DIRS?.split(path.delimiter)
    .map((d) => d.trim())
    .filter(Boolean)
  if (skillDirs && skillDirs.length) layer.skillDirs = skillDirs
  const externalSkills = env.COGNIA_EXTERNAL_SKILLS?.trim().toLowerCase()
  if (externalSkills) {
    layer.externalSkills = !["0", "false", "no", "off"].includes(externalSkills)
  }

  // TUI theme override.
  const theme = env.COGNIA_THEME?.trim()
  if (theme) layer.theme = theme

  // TUI layout override (`fullscreen` / `scrollback`). Ignored when it isn't a
  // recognized mode so a typo falls back to the resolved default rather than
  // throwing — the schema only validates files, not env.
  const layout = env.COGNIA_LAYOUT?.trim().toLowerCase()
  if (layout === "fullscreen" || layout === "scrollback") layer.layout = layout

  // Fullscreen mouse model override (`select` / `scroll`). Same lenient parse.
  const mouse = env.COGNIA_MOUSE?.trim().toLowerCase()
  if (mouse === "select" || mouse === "scroll") layer.mouse = mouse

  // Preferred external editor override (bare command, e.g. `code` / `cursor`).
  const editor = env.COGNIA_EDITOR?.trim()
  if (editor) layer.editor = editor

  // COGNIA_API_KEY / COGNIA_BASE_URL apply to the active provider (resolved
  // against an explicit COGNIA_PROVIDER or the default).
  const activeProvider = provider ?? DEFAULT_RESOLVED_CONFIG.provider
  const genericKey = env.COGNIA_API_KEY?.trim()
  const genericBase = env.COGNIA_BASE_URL?.trim()
  if (genericKey || genericBase) {
    const merged: Record<string, ProviderConfig> = { ...(layer.providers ?? {}) }
    merged[activeProvider] = {
      ...(merged[activeProvider] ?? {}),
      ...(genericKey ? { apiKey: genericKey } : {}),
      ...(genericBase ? { baseURL: genericBase } : {}),
    }
    layer.providers = merged
  }
  return layer
}

/**
 * Pure config resolution. Reads at most three files via the injected reader,
 * applies env + flags, and returns a fully-defaulted {@link ResolvedConfig}.
 */
export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const { home, cwd, env, flags, readFile } = input

  const userFile = parseJsonFile(readFile(userConfigPath(home)), cliConfigFileSchema, "config.json")
  const creds = parseJsonFile(
    readFile(credentialsPath(home)),
    credentialsFileSchema,
    "credentials.json"
  )
  const projectFile = parseJsonFile(
    readFile(projectConfigPath(cwd)),
    cliConfigFileSchema,
    "project config.json"
  )

  let acc: ResolvedConfig = {
    ...DEFAULT_RESOLVED_CONFIG,
    builtinTools: { ...DEFAULT_RESOLVED_CONFIG.builtinTools },
    providers: {},
    cwd,
  }
  acc = applyLayer(acc, userFile ?? undefined)
  acc = applyCredentials(acc, creds)
  acc = applyLayer(acc, projectFile ?? undefined)
  acc = applyLayer(acc, envLayer(env))
  acc = applyLayer(acc, flags)

  // Bind the active model to the ACTIVE provider's slot so `resolveActiveModel`'s
  // per-provider precedence drives it (per-provider memory is authoritative; a
  // bare top-level `model` otherwise bleeds across every provider).
  //   • An explicit per-run override (`--model` / `COGNIA_MODEL`) FORCES the slot.
  //   • A persisted top-level `model` (legacy global pin) is PROMOTED into the
  //     active provider only when that provider has no model yet — preserving an
  //     upgrading user's remembered model without clobbering newer per-provider
  //     memory, and scoping it so it can't show for other providers.
  const overrideModel = flags?.model?.trim() || env.COGNIA_MODEL?.trim()
  if (overrideModel) {
    acc.providers = {
      ...acc.providers,
      [acc.provider]: { ...acc.providers[acc.provider], model: overrideModel },
    }
  } else if (acc.model && !acc.providers[acc.provider]?.model) {
    acc.providers = {
      ...acc.providers,
      [acc.provider]: { ...acc.providers[acc.provider], model: acc.model },
    }
  }

  // A flag/config cwd may be relative — resolve it against the process cwd so
  // the agent always hands the sidecar an absolute working directory.
  acc.cwd = path.isAbsolute(acc.cwd) ? acc.cwd : path.resolve(cwd, acc.cwd)
  return acc
}

/** Real-fs reader: returns file text or `null` when missing. */
export const fsReader: FileReader = (absPath) => {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

/**
 * Load + resolve config using the real environment and filesystem. `flags`
 * comes from the command parser; everything else is read from the OS.
 */
export function loadConfig(flags?: Partial<CliConfigFile>): ResolvedConfig {
  const env = process.env
  const home = resolveHome(env, os.homedir())
  const cwd = flags?.cwd ?? process.cwd()
  return resolveConfig({ home, cwd, env, flags, readFile: fsReader })
}
