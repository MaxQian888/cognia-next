/**
 * CLI agent-mode support — parity with the desktop's custom-mode system.
 *
 * The desktop stores agent modes (built-in + user "custom" modes) in a Zustand
 * store and feeds the active one to `resolveSendOptions` as
 * `BuildOptionsContext.agentMode`. There, a mode's `systemPrompt` appends to the
 * prompt, its `tools` union into the allow-list, its `permissionMode` flows into
 * the SDK permission, and its model override joins the model precedence.
 *
 * The CLI has no Dexie/Zustand, so this module mirrors the same surface from the
 * filesystem + config:
 *   - Built-in modes come from the shared {@link BUILT_IN_AGENT_MODES} catalog
 *     (general / plan / build / code-gen / …) — identical ids to the desktop.
 *   - Custom modes are discovered from `.cognia/modes/*.json` under the cwd +
 *     home roots (mirrors `.cognia/agents/*.md` subagent discovery). The file's
 *     stem is the mode id; first root wins on a collision (project > global).
 *
 * The resolved {@link AgentModeConfig} is threaded into `toBuildContext` so the
 * SAME `resolveSendOptions` applies it — no CLI-specific option assembly.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import { z } from "zod"

import { BUILT_IN_AGENT_MODES, type AgentModeConfig } from "@/types/agent/agent-mode"

import { PERMISSION_MODES } from "./schema"

/** A concrete permission-mode value (mirrors `state/types.PermissionMode`). */
type PermissionMode = (typeof PERMISSION_MODES)[number]

/** Minimal fs surface discovery needs (same shape as `discover-agents`). */
export interface ModeFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  readText(path: string): Promise<string>
}

const defaultFs: ModeFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async readDir(p) {
    try {
      return await nodeFs.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFs.readFile(p, "utf8"),
}

/**
 * A custom-mode JSON file. Intentionally a SUBSET of the desktop's
 * `CustomModeConfig` — only the fields `resolveSendOptions` actually consumes.
 * The `id` is the filename stem, so the file never carries one.
 */
export const customModeFileSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    icon: z.string().min(1).optional(),
    /** Appended to the system prompt (under the same separator as skills). */
    systemPrompt: z.string().optional(),
    /** Tool names unioned into the allow-list for this mode. */
    tools: z.array(z.string().min(1)).optional(),
    /** SDK permission ruleset this mode enforces (e.g. `"plan"` ⇒ read-only). */
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    /** Model override — joins the model precedence above the app default. */
    model: z.string().min(1).optional(),
    outputFormat: z.enum(["text", "code", "html", "react", "markdown"]).optional(),
    temperature: z.number().optional(),
    maxTokens: z.number().optional(),
  })
  .strict()

export type CustomModeFile = z.infer<typeof customModeFileSchema>

/**
 * Build a resolved {@link AgentModeConfig} from a validated custom-mode file.
 * The `model` / `temperature` / `maxTokens` map onto the `*Override` fields
 * `buildAgentModeSessionUpdate` reads (`"modelOverride" in agentMode`), so the
 * shared session-update helper picks them up unchanged.
 */
export function customModeToConfig(id: string, file: CustomModeFile): AgentModeConfig {
  return {
    id,
    type: "custom",
    name: file.name,
    description: file.description ?? "",
    icon: file.icon ?? "Bot",
    ...(file.systemPrompt ? { systemPrompt: file.systemPrompt } : {}),
    ...(file.tools ? { tools: file.tools } : {}),
    ...(file.permissionMode ? { permissionMode: file.permissionMode } : {}),
    ...(file.outputFormat ? { outputFormat: file.outputFormat } : {}),
    // Override fields live on the desktop's CustomModeConfig; attach them so the
    // shared `buildAgentModeSessionUpdate` (which checks `"…Override" in mode`)
    // applies them. Cast because the public AgentModeConfig type omits them.
    ...(file.model ? { modelOverride: file.model } : {}),
    ...(file.temperature !== undefined ? { temperatureOverride: file.temperature } : {}),
    ...(file.maxTokens !== undefined ? { maxTokensOverride: file.maxTokens } : {}),
  } as AgentModeConfig
}

/**
 * Discover custom agent modes from each root's `.cognia/modes/*.json`. First
 * root wins on an id collision (project overrides global). Unreadable / invalid
 * files are skipped (best-effort — a bad mode file never breaks chat).
 */
export async function discoverCustomAgentModes(
  roots: string[],
  fs: ModeFs = defaultFs
): Promise<AgentModeConfig[]> {
  const byId = new Map<string, AgentModeConfig>()
  for (const root of roots) {
    const dir = path.join(root, ".cognia", "modes")
    if (!(await fs.exists(dir))) continue
    const names = await fs.readDir(dir)
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const id = name.slice(0, -5)
      if (byId.has(id)) continue
      try {
        const parsed = customModeFileSchema.safeParse(
          JSON.parse(await fs.readText(path.join(dir, name)))
        )
        if (parsed.success) byId.set(id, customModeToConfig(id, parsed.data))
      } catch {
        // Unreadable / malformed JSON — skip this file.
      }
    }
  }
  return [...byId.values()]
}

/**
 * The built-in modes meaningful in the terminal CLI: those that declare NO tool
 * list. A mode's `tools` become a RESTRICTIVE allow-list in `resolveSendOptions`
 * (`opts.allowedTools` is a whitelist), and the desktop's tool-bearing modes
 * (web-design / code-gen / data-analysis / research / ppt-generation / workflow
 * / academic) reference desktop-only tools — `execute_code`, `academic_search`,
 * preview surfaces — that don't exist in the CLI. Offering them would whitelist
 * those phantom tools and block every real CLI tool. So the CLI exposes only the
 * tool-less built-ins (general / plan / build / writing); their value is the
 * system prompt + permission ruleset, which all apply correctly. Custom modes
 * may still declare `tools` — the user authoring one knows they're scoping the
 * allow-list.
 */
export const CLI_BUILTIN_AGENT_MODES: AgentModeConfig[] = BUILT_IN_AGENT_MODES.filter(
  (m) => !m.tools || m.tools.length === 0
)

/** Every selectable mode: CLI built-ins first, then discovered custom modes. */
export function listAgentModes(customModes: AgentModeConfig[]): AgentModeConfig[] {
  return [...CLI_BUILTIN_AGENT_MODES, ...customModes]
}

/**
 * Resolve an active mode id to its config. CLI built-in ids win over custom ones
 * (a custom file can't shadow `plan`/`build`/…); returns `undefined` for an
 * unknown id, a desktop-only built-in (not exposed in the CLI), or when no mode
 * is selected — all of which degrade safely to plain chat.
 */
export function resolveAgentMode(
  modeId: string | undefined | null,
  customModes: AgentModeConfig[]
): AgentModeConfig | undefined {
  if (!modeId) return undefined
  return (
    CLI_BUILTIN_AGENT_MODES.find((m) => m.id === modeId) ?? customModes.find((m) => m.id === modeId)
  )
}

/**
 * The permission mode the CLI session should run with, given the configured
 * permission mode and the active agent mode.
 *
 * An explicitly-chosen permission mode (anything other than the baseline
 * `"default"`, set via `/mode`, `--permission-mode`, or config) always wins —
 * the user's direct choice is authoritative. Otherwise a mode that declares its
 * own permission ruleset (e.g. the built-in `plan` mode) applies it, so picking
 * "Plan" actually makes the agent read-only without a second `/mode` step.
 */
export function effectivePermissionMode(
  configPermissionMode: PermissionMode,
  mode: AgentModeConfig | undefined
): PermissionMode {
  if (configPermissionMode !== "default") return configPermissionMode
  return mode?.permissionMode ?? configPermissionMode
}
