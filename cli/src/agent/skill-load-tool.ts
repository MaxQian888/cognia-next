/**
 * The `load_skill` tool — the second half of name-only skill loading
 * (progressive disclosure). In `skillLoadMode: "name"` the system prompt carries
 * only a name + description CATALOG of the enabled skills (see
 * `renderSkillsCatalog`); this tool lets the model pull a skill's FULL
 * instructions on demand instead of paying every body's token weight up front.
 *
 * It rides the SAME plugin-tool round-trip as `dispatch_agent` (no sidecar/Rust
 * changes): a manifest entry surfaces it to the sidecar's `cognia-plugin-tools`
 * MCP server, the model's call comes back as a `plugin_tool_exec` event, and
 * {@link handleCliLoadSkill} resolves it through the same scoped, resource-aware
 * runtime loader as desktop. Works on BOTH dispatch channels (Anthropic +
 * ai-sdk), exactly like the dispatch tool.
 */
import type { Skill } from "@cognia/agent-config-types"
import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"
import type { PluginToolExecRequest, PluginToolExecResponse } from "@/lib/claude/plugin-tool-ipc"
import {
  createSkillLoadContext,
  loadSkillForSession,
  loadSkillResourceForSession,
  releaseSkillLoadContext,
  type CreateSkillLoadContextInput,
  type SkillLoadScope,
} from "@/lib/skills/runtime-loader"

export const LOAD_SKILL_TOOL_NAME = "load_skill"
export const LOAD_SKILL_RESOURCE_TOOL_NAME = "load_skill_resource"

/** Synthetic plugin id namespacing the tool in the manifest / audit trail. */
export const LOAD_SKILL_PLUGIN_ID = "cognia-load-skill"

/** A skill the model may load (drives the `skill_id` enum + the description list). */
export interface LoadableSkill {
  id: string
  name: string
  description?: string
}

/** Build the tool's JSON schema; constrains `skill_id` to the known ids. */
export function buildLoadSkillSchema(available: LoadableSkill[]): object {
  const ids = available.map((s) => s.id)
  const idSchema: Record<string, unknown> = {
    type: "string",
    description: "Id of the skill whose full instructions to load (see the skills catalog).",
  }
  if (ids.length > 0) idSchema.enum = ids
  return {
    type: "object",
    properties: { skill_id: idSchema },
    required: ["skill_id"],
  }
}

/** Description lists the loadable skills so the model picks the right id. */
function buildDescription(available: LoadableSkill[]): string {
  const base =
    "Load the full instructions for one of the available skills by its id. Call this when a " +
    "skill listed in your system prompt's skills catalog is relevant to the task, then follow " +
    "the instructions it returns. Pass `{skill_id}`."
  if (available.length === 0) return base
  const list = available.map((s) => `- ${s.id}: ${s.description ?? s.name}`).join("\n")
  return `${base}\n\nAvailable skills:\n${list}`
}

/** The manifest entry that surfaces `load_skill` to the sidecar tool server. */
export function buildLoadSkillManifestEntry(available: LoadableSkill[]): PluginToolManifestEntry {
  return {
    name: LOAD_SKILL_TOOL_NAME,
    description: buildDescription(available),
    jsonSchema: buildLoadSkillSchema(available),
    pluginId: LOAD_SKILL_PLUGIN_ID,
  }
}

/** Build the complete read-only progressive loader surface for the CLI. */
export function buildLoadSkillManifestEntries(
  available: LoadableSkill[]
): PluginToolManifestEntry[] {
  const ids = available.map((skill) => skill.id)
  const resourceSkillIdSchema: Record<string, unknown> = { type: "string" }
  if (ids.length > 0) resourceSkillIdSchema.enum = ids
  return [
    buildLoadSkillManifestEntry(available),
    {
      name: LOAD_SKILL_RESOURCE_TOOL_NAME,
      description: "Read a paged UTF-8 resource from a Skill available in this send.",
      jsonSchema: {
        type: "object",
        properties: {
          skill_id: resourceSkillIdSchema,
          path: { type: "string" },
          offset: { type: "number", minimum: 0 },
          limit: { type: "number", minimum: 1, maximum: 65536 },
        },
        required: ["skill_id", "path"],
      },
      pluginId: LOAD_SKILL_PLUGIN_ID,
    },
  ]
}

/** Parse the model's args into a skill id (accepts a few common aliases). */
export function parseLoadSkillArgs(args: Record<string, unknown>): string | null {
  const raw =
    (args as { skill_id?: unknown }).skill_id ??
    (args as { skillId?: unknown }).skillId ??
    (args as { id?: unknown }).id ??
    (args as { name?: unknown }).name
  return typeof raw === "string" && raw.trim() ? raw.trim() : null
}

/** Render a loaded skill into the tool-result text the model reads. */
export function renderLoadedSkill(skill: Skill): string {
  const body = skill.content.trim() || "_(this skill has an empty body)_"
  return `# ${skill.name}\n\n${body}`
}

export interface LoadSkillDeps {
  get?: CreateSkillLoadContextInput["getSkill"]
  listResources?: CreateSkillLoadContextInput["listResources"]
  recordUsage?: CreateSkillLoadContextInput["recordUsage"]
}

/** Register the exact enabled skill set for one resolved CLI session. */
export function registerCliSkillLoadContext(
  sessionId: string,
  input: LoadSkillDeps & {
    allowedSkillIds: Iterable<string>
    explicitSkillIds?: Iterable<string>
    allowDisabledSkillIds?: Iterable<string>
    turnId?: string
    attemptId?: string
  }
): void {
  createSkillLoadContext({
    sessionId,
    turnId: input.turnId,
    attemptId: input.attemptId,
    allowedSkillIds: input.allowedSkillIds,
    explicitSkillIds: input.explicitSkillIds,
    allowDisabledSkillIds: input.allowDisabledSkillIds,
    getSkill: input.get,
    listResources: input.listResources,
    recordUsage: input.recordUsage,
  })
}

export function releaseCliSkillLoadContext(sessionId: string): void {
  releaseSkillLoadContext(sessionId)
}

function requestScope(req: PluginToolExecRequest): SkillLoadScope {
  return {
    sessionId: req.sessionId,
    turnId: req.turnId,
    attemptId: req.attemptId,
  }
}

/**
 * Resolve a `load_skill` `plugin_tool_exec` request within the registered send
 * scope. Never throws — every failure mode collapses onto a readable
 * `result`/`error` value so the model's tool call always settles.
 */
export async function handleCliLoadSkill(
  req: PluginToolExecRequest,
  _deps: LoadSkillDeps = {}
): Promise<PluginToolExecResponse> {
  const base = {
    type: "plugin_tool_response" as const,
    sessionId: req.sessionId,
    toolUseId: req.toolUseId,
  }
  const id = parseLoadSkillArgs(req.args)
  if (!id) {
    return {
      ...base,
      result: "load_skill: provide `{skill_id}` — the id of a skill from the catalog.",
    }
  }
  try {
    return { ...base, result: await loadSkillForSession(requestScope(req), id) }
  } catch (err) {
    return {
      ...base,
      error: `load_skill failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/** Resolve a scoped, paged Skill resource over the same CLI host-tool path. */
export async function handleCliLoadSkillResource(
  req: PluginToolExecRequest
): Promise<PluginToolExecResponse> {
  const base = {
    type: "plugin_tool_response" as const,
    sessionId: req.sessionId,
    toolUseId: req.toolUseId,
  }
  const skillId = parseLoadSkillArgs(req.args)
  const path = typeof req.args.path === "string" ? req.args.path.trim() : ""
  if (!skillId || !path) {
    return {
      ...base,
      result: "load_skill_resource: provide `{skill_id, path}` from a loaded Skill manifest.",
    }
  }
  try {
    return {
      ...base,
      result: await loadSkillResourceForSession(
        requestScope(req),
        skillId,
        path,
        typeof req.args.offset === "number" ? req.args.offset : 0,
        typeof req.args.limit === "number" ? req.args.limit : undefined
      ),
    }
  } catch (err) {
    return {
      ...base,
      error: `load_skill_resource failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
