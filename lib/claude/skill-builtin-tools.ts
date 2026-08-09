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
import { loadSkillForSession, loadSkillResourceForSession } from "@/lib/skills/runtime-loader"

export const SKILL_TOOL_NAME = "Skill"
export const LOAD_SKILL_TOOL_NAME = "load_skill"
export const LOAD_SKILL_RESOURCE_TOOL_NAME = "load_skill_resource"

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

/** Scoped, non-side-effecting loader tools used by desktop progressive disclosure. */
export function buildProgressiveSkillManifestEntries(
  available: Array<{ id: string; slug?: string; name: string; description?: string }>,
  includeResourceLoader: boolean
): SkillBuiltinManifestEntry[] {
  const ids = available.map((skill) => skill.id)
  const catalog = available
    .map(
      (skill) => `- ${skill.id}: ${skill.slug ?? skill.name} — ${skill.description ?? skill.name}`
    )
    .join("\n")
  const entries: SkillBuiltinManifestEntry[] = [
    {
      name: LOAD_SKILL_TOOL_NAME,
      description:
        "Load one Skill available in this send. The id must come from the scoped catalog.\n" +
        catalog,
      jsonSchema: {
        type: "object",
        properties: { skill_id: { type: "string", enum: ids } },
        required: ["skill_id"],
      },
      pluginId: SKILL_BUILTIN_PLUGIN_ID,
    },
  ]
  if (includeResourceLoader) {
    entries.push({
      name: LOAD_SKILL_RESOURCE_TOOL_NAME,
      description: "Read a paged UTF-8 resource from a Skill listed for this send.",
      jsonSchema: {
        type: "object",
        properties: {
          skill_id: { type: "string", enum: ids },
          path: { type: "string" },
          offset: { type: "number", minimum: 0 },
          limit: { type: "number", minimum: 1, maximum: 65536 },
        },
        required: ["skill_id", "path"],
      },
      pluginId: SKILL_BUILTIN_PLUGIN_ID,
    })
  }
  return entries
}

/** Is this tool name the promoted Skill built-in? */
export function isSkillBuiltinTool(name: string): boolean {
  return (
    name === SKILL_TOOL_NAME ||
    name === LOAD_SKILL_TOOL_NAME ||
    name === LOAD_SKILL_RESOURCE_TOOL_NAME
  )
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
  listSkillResources?: import("@/lib/skills/runtime-loader").RuntimeLoaderDeps["listResources"]
  recordSkillUsage?: import("@/lib/skills/runtime-loader").RuntimeLoaderDeps["recordUsage"]
}

/**
 * Execute the Skill tool host-side: resolve the requested skill (built-in
 * catalog first, then custom skills) and return its instructions as text the
 * model follows. Returns an error string when the skill can't be found.
 */
export async function runSkillBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: SkillToolRunDeps,
  context?: { sessionId: string }
): Promise<unknown> {
  if (name === LOAD_SKILL_TOOL_NAME) {
    const skillId = String(args.skill_id ?? "").trim()
    if (!skillId) return { ok: false, code: "invalid_args", error: "skill_id is required." }
    const runtimeDeps = deps.listSkillResources
      ? {
          listResources: deps.listSkillResources,
          recordUsage: deps.recordSkillUsage ?? (async () => undefined),
        }
      : undefined
    return loadSkillForSession(context?.sessionId ?? "", skillId, runtimeDeps)
  }
  if (name === LOAD_SKILL_RESOURCE_TOOL_NAME) {
    const skillId = String(args.skill_id ?? "").trim()
    const path = String(args.path ?? "").trim()
    if (!skillId || !path) {
      return { ok: false, code: "invalid_args", error: "skill_id and path are required." }
    }
    const runtimeDeps = deps.listSkillResources
      ? {
          listResources: deps.listSkillResources,
          recordUsage: deps.recordSkillUsage ?? (async () => undefined),
        }
      : undefined
    return loadSkillResourceForSession(
      context?.sessionId ?? "",
      skillId,
      path,
      typeof args.offset === "number" ? args.offset : 0,
      typeof args.limit === "number" ? args.limit : undefined,
      runtimeDeps
    )
  }
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
