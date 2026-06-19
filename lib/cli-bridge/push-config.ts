/**
 * Desktop → CLI config push (WS3).
 *
 * Projects the desktop's agent defaults into the cognia CLI's
 * `~/.cognia/config.json`, preserving every key the desktop doesn't own (the
 * CLI's `cliConfigFileSchema` is `.strict()`, so we only ever write keys it
 * recognises — anything else would make the CLI reject the file). Secrets are
 * NOT written here; they go to `credentials.json` (see push-credentials.ts).
 *
 * The projected subset is re-declared locally (not imported from `cli/`) so the
 * app bundle never depends on the standalone CLI package; the enum guards
 * mirror `cli/src/config/schema.ts`.
 */

import type { AppSettings, BuiltinToolsConfig } from "@/lib/claude/types"
import { readTextFile } from "@/lib/claude/ipc"

import { resolveCliHome, writeCliHomeFile } from "./home"

export const CONFIG_FILE_NAME = "config.json"

/** CLI permission modes (mirror of `cli/src/config/schema.ts:PERMISSION_MODES`). */
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan"] as const
/** CLI output styles (mirror of `cli/src/config/schema.ts:OUTPUT_STYLES`). */
const OUTPUT_STYLES = ["default", "concise", "explanatory", "learning"] as const
/** The exact builtin-tool keys the CLI's strict schema accepts. */
const BUILTIN_TOOL_KEYS: ReadonlyArray<keyof BuiltinToolsConfig> = [
  "fileExtras",
  "coreFiles",
  "coreFilesOnAnthropic",
  "git",
  "process",
  "environment",
  "shellAdvanced",
  "terminalRepl",
  "lsp",
]

/** The subset of CLI `config.json` keys the desktop owns. */
export interface CliConfigSubset {
  provider?: string
  model?: string
  systemPrompt?: string
  permissionMode?: (typeof PERMISSION_MODES)[number]
  allowedTools?: string[]
  builtinTools?: Partial<BuiltinToolsConfig>
  webTools?: boolean
  skillTool?: boolean
  slashCommandTool?: boolean
  outputStyle?: (typeof OUTPUT_STYLES)[number]
}

export type ConfigSettingsSlice = Partial<
  Pick<
    AppSettings,
    | "defaultModel"
    | "defaultProvider"
    | "defaultSystemPrompt"
    | "permissionMode"
    | "alwaysAllowTools"
    | "builtinTools"
    | "webTools"
    | "selfInvokeTools"
    | "outputStyle"
  >
>

/**
 * Pure: derive the CLI-config subset from AppSettings. Only includes keys with
 * a meaningful value and guards enums to the CLI's accepted set so the strict
 * schema never rejects the file.
 */
export function projectAppConfigToCli(settings: ConfigSettingsSlice): CliConfigSubset {
  const out: CliConfigSubset = {}
  if (settings.defaultProvider) out.provider = settings.defaultProvider
  if (settings.defaultModel) out.model = settings.defaultModel
  if (settings.defaultSystemPrompt?.trim()) out.systemPrompt = settings.defaultSystemPrompt
  if (
    settings.permissionMode &&
    (PERMISSION_MODES as readonly string[]).includes(settings.permissionMode)
  ) {
    out.permissionMode = settings.permissionMode as CliConfigSubset["permissionMode"]
  }
  if (Array.isArray(settings.alwaysAllowTools) && settings.alwaysAllowTools.length > 0) {
    out.allowedTools = [...settings.alwaysAllowTools]
  }
  if (settings.builtinTools) {
    const bt: Partial<BuiltinToolsConfig> = {}
    for (const key of BUILTIN_TOOL_KEYS) {
      const value = settings.builtinTools[key]
      if (typeof value === "boolean") bt[key] = value
    }
    if (Object.keys(bt).length > 0) out.builtinTools = bt
  }
  if (settings.webTools) out.webTools = settings.webTools.enabled !== false
  if (settings.selfInvokeTools?.skill !== undefined) {
    out.skillTool = Boolean(settings.selfInvokeTools.skill)
  }
  if (settings.selfInvokeTools?.slashCommand !== undefined) {
    out.slashCommandTool = Boolean(settings.selfInvokeTools.slashCommand)
  }
  if (settings.outputStyle && (OUTPUT_STYLES as readonly string[]).includes(settings.outputStyle)) {
    out.outputStyle = settings.outputStyle as CliConfigSubset["outputStyle"]
  }
  return out
}

/**
 * Pure: overlay the owned subset onto the existing parsed config object,
 * preserving every unmanaged key verbatim.
 */
export function mergeCliConfig(
  existing: unknown,
  subset: CliConfigSubset
): Record<string, unknown> {
  const base =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {}
  return { ...base, ...subset }
}

export interface PushConfigDeps {
  resolveHome?: () => Promise<string | null>
  read?: (path: string) => Promise<string>
  write?: (fileName: string, content: string, secret: boolean) => Promise<void>
  join?: (home: string, file: string) => string
}

function defaultJoin(home: string, file: string): string {
  return `${home.replace(/[/\\]+$/, "")}/${file}`
}

/**
 * Read → patch → write the CLI config.json. Returns `false` when there is no
 * CLI home to write to (web / unresolvable), `true` after a successful write.
 */
export async function pushConfigToCli(
  settings: ConfigSettingsSlice,
  deps: PushConfigDeps = {}
): Promise<boolean> {
  const home = await (deps.resolveHome ?? resolveCliHome)()
  if (!home) return false

  const read = deps.read ?? readTextFile
  const join = deps.join ?? defaultJoin
  let existing: unknown = {}
  try {
    const raw = await read(join(home, CONFIG_FILE_NAME))
    existing = raw && raw.trim() ? JSON.parse(raw) : {}
  } catch {
    // Missing or unparseable file → start fresh (the CLI tolerates an absent
    // config.json; an unparseable one would be overwritten with a valid tree).
    existing = {}
  }

  const merged = mergeCliConfig(existing, projectAppConfigToCli(settings))
  const write = deps.write ?? writeCliHomeFile
  await write(CONFIG_FILE_NAME, JSON.stringify(merged, null, 2) + "\n", false)
  return true
}
