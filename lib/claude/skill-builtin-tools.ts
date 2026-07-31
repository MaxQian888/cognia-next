/**
 * First-class `Skill` tool, host-routed like the promoted web tools.
 *
 * Claude Code parity: lets the model load a skill's instructions into the
 * conversation mid-turn and then follow them, instead of relying solely on the
 * host's surface-based auto-activation or an explicit `@skill:` mention.
 *
 * Host-routed (renderer + CLI) because resolving skill content reaches the
 * built-in catalog (`lib/skills/built-in-catalog`) and the Dexie custom-skills
 * table (`lib/db/skills`) — TS the pure `.mjs` sidecar can't import.
 * `build-options` appends {@link buildSkillManifestEntries} when the
 * `selfInvokeTools.skill` setting is on (opt-in); `plugin-tool-ipc` resolves
 * the call via {@link runSkillBuiltinTool}.
 */

import { BUILT_IN_SKILL_CATALOG } from "@/lib/skills/built-in-catalog"

export const SKILL_TOOL_NAME = "Skill"

/** Synthetic plugin id tagging the promoted built-in Skill manifest entry. */
export const SKILL_BUILTIN_PLUGIN_ID = "cognia-skill-builtin"

export interface SkillBuiltinManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

const SKILL_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The skill id (or name) to load — one of the listed skills, or a custom skill.",
    },
    input: {
      type: "string",
      description: "Optional context or arguments to pass along with the skill's instructions.",
    },
  },
  required: ["name"],
} as const

/**
 * Manifest entry for the Skill tool. The description embeds the built-in skill
 * catalog so the model can discover what's available (mirrors how dispatch_agent
 * embeds the dispatchable subagent list).
 */
export function buildSkillManifestEntries(): SkillBuiltinManifestEntry[] {
  const list = BUILT_IN_SKILL_CATALOG.map((e) => `- ${e.id}: ${e.name}`).join("\n")
  const description =
    "Load a skill's instructions into the conversation and then follow them. " +
    "Call this when the task matches a skill. Built-in skills:\n" +
    `${list}\n` +
    "You may also pass a custom skill id or name."
  return [
    {
      name: SKILL_TOOL_NAME,
      description,
      jsonSchema: SKILL_SCHEMA as unknown as Record<string, unknown>,
      pluginId: SKILL_BUILTIN_PLUGIN_ID,
    },
  ]
}

/** Is this tool name the promoted Skill built-in? */
export function isSkillBuiltinTool(name: string): boolean {
  return name === SKILL_TOOL_NAME
}

/** A resolved skill, narrowed to the fields the tool returns. */
export interface ResolvedSkill {
  id: string
  name: string
  content: string
}

export interface SkillToolRunDeps {
  /** Resolve a built-in catalog skill by bundle id (sync, always available). */
  getCatalogSkill?: (id: string) => ResolvedSkill | undefined
  /** Resolve a custom (Dexie) skill by id or name. Optional (absent in CLI). */
  loadCustomSkill?: (idOrName: string) => Promise<ResolvedSkill | undefined>
}

/**
 * Execute the Skill tool host-side: resolve the requested skill (built-in
 * catalog first, then custom skills) and return its instructions as text the
 * model follows. Returns an error string when the skill can't be found.
 */
export async function runSkillBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: SkillToolRunDeps
): Promise<unknown> {
  if (name !== SKILL_TOOL_NAME) return `Error: unknown skill tool: ${name}`
  const key = String(args?.name ?? "").trim()
  if (!key) return "Error: the Skill tool requires a `name` (skill id or name)."

  let skill = deps.getCatalogSkill?.(key)
  if (!skill && deps.loadCustomSkill) {
    skill = await deps.loadCustomSkill(key)
  }
  if (!skill) {
    return `Error: skill not found: "${key}". Pass one of the listed built-in skill ids, or a custom skill id/name.`
  }

  const inputNote =
    typeof args?.input === "string" && args.input.trim().length > 0
      ? `\n\nCaller-provided input:\n${args.input}`
      : ""
  return `Skill "${skill.name}" loaded. Follow these instructions:\n\n${skill.content}${inputNote}`
}
