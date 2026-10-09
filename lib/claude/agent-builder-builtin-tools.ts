/**
 * The Agent Builder's tools (ADR-0220): read the draft, list what it may
 * reference, write fields, and — with the user's approval — create the agent.
 *
 * Same shape as every built-in family (`project-coordinator-builtin-tools.ts`):
 * manifest entries the send path appends to `pluginTools`, a predicate the IPC
 * dispatcher routes on, and a runner over injected deps that executes in the
 * renderer. Offered only on an `"agent-builder"` session, and each call
 * re-checks that the caller IS one, so a tool name replayed into another
 * conversation cannot write anything. External runtimes reach these tools
 * through the renderer tool host like any other built-in family.
 */

import type { AgentBuilderSessionState, Character, ChatSession } from "@cognia/agent-config-types"
import {
  BUILDER_PERMISSION_MODES,
  DRAFT_DESCRIPTION_MAX,
  DRAFT_NAME_MAX,
  DRAFT_STARTERS_MAX,
  renderDraftForModel,
  type DraftCatalogs,
  type DraftPatch,
} from "@/lib/agents/builder/draft-ops"
import { AGENT_AVATAR_COLORS } from "@/lib/agents/editor-state"

export const AGENT_BUILDER_BUILTIN_PLUGIN_ID = "cognia-agent-builder-builtin"

export const AGENT_BUILDER_TOOL_NAMES = {
  getDraft: "agent_builder_get_draft",
  listCatalog: "agent_builder_list_catalog",
  updateDraft: "agent_builder_update_draft",
  createAgent: "agent_builder_create_agent",
} as const

const TOOLS = new Set<string>(Object.values(AGENT_BUILDER_TOOL_NAMES))

export const CATALOG_KINDS = [
  "skills",
  "plugin_skills",
  "mcp_servers",
  "knowledge_bases",
  "models",
] as const
type CatalogKind = (typeof CATALOG_KINDS)[number]

export interface AgentBuilderManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

function entry(
  name: string,
  description: string,
  jsonSchema: Record<string, unknown>
): AgentBuilderManifestEntry {
  return { name, description, jsonSchema, pluginId: AGENT_BUILDER_BUILTIN_PLUGIN_ID }
}

const stringArray = { type: "array", items: { type: "string" } }

const DRAFT_PATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string", maxLength: DRAFT_NAME_MAX, description: "Short, specific agent name." },
    description: {
      type: "string",
      maxLength: DRAFT_DESCRIPTION_MAX,
      description: "One sentence: what the agent does, shown in lists.",
    },
    avatar_emoji: { type: "string", description: "A single emoji for the avatar." },
    avatar_color: {
      type: "string",
      enum: [...AGENT_AVATAR_COLORS],
      description: "Avatar background color.",
    },
    instructions: {
      type: "string",
      description: "The agent's system prompt, written to the agent in the second person.",
    },
    persona_tone: { type: "string", description: "Tone of voice, a few words." },
    persona_personality: { type: "string", description: "Personality, one or two sentences." },
    opening_message: {
      type: "string",
      description: "Optional greeting shown as the first message of a new conversation.",
    },
    conversation_starters: {
      ...stringArray,
      maxItems: DRAFT_STARTERS_MAX,
      description: "Example requests a user would send this agent, phrased as the user.",
    },
    skill_ids: {
      ...stringArray,
      description: "Skill ids from agent_builder_list_catalog(skills).",
    },
    plugin_skill_ids: {
      ...stringArray,
      description: "Plugin skill ids from agent_builder_list_catalog(plugin_skills).",
    },
    mcp_server_ids: {
      anyOf: [stringArray, { type: "null" }],
      description: "Restrict to these MCP server ids; null means every enabled server.",
    },
    knowledge_base_ids: {
      ...stringArray,
      description: "Knowledge base ids from agent_builder_list_catalog(knowledge_bases).",
    },
    model: { type: "string", description: "Model id for execution; empty string for the default." },
    plan_model: { type: "string", description: "Model id for planning; empty for the default." },
    utility_model: { type: "string", description: "Model id for small utility calls." },
    permission_mode: {
      type: "string",
      enum: [...BUILDER_PERMISSION_MODES, "inherit"],
      description: "How tool use is approved. inherit follows the app setting.",
    },
    effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max", "inherit"] },
    max_turns: {
      anyOf: [{ type: "integer", minimum: 1, maximum: 100 }, { type: "null" }],
      description: "Cap on agent turns per run; null clears it.",
    },
    allowed_tools: {
      ...stringArray,
      description: "Only these tools may be used; empty = no limit.",
    },
    disallowed_tools: { ...stringArray, description: "Tools the agent may never use." },
    enable_browser_tools: { type: "boolean" },
    enable_computer_use: { type: "boolean" },
    brief_mode: { type: "boolean", description: "Prefer short answers." },
    memory: {
      type: "object",
      additionalProperties: false,
      properties: {
        recall: { type: "boolean" },
        create: { type: "boolean" },
        update: { type: "boolean" },
        forget: { type: "boolean" },
        auto_learn: { type: "boolean" },
      },
    },
  },
}

export function buildAgentBuilderManifestEntries(): AgentBuilderManifestEntry[] {
  const T = AGENT_BUILDER_TOOL_NAMES
  return [
    entry(
      T.getDraft,
      "Read the agent draft as it stands now, including edits the user made in the panel, and which required fields are still missing.",
      { type: "object", additionalProperties: false, properties: {} }
    ),
    entry(
      T.listCatalog,
      "List what the agent may reference: skills, plugin skills, MCP servers, knowledge bases, or model ids. Use only ids returned here.",
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: [...CATALOG_KINDS] },
          query: {
            type: "string",
            description: "Optional case-insensitive filter on name or description.",
          },
        },
      }
    ),
    entry(
      T.updateDraft,
      "Write fields of the agent draft. Only the fields you pass change; the panel updates live. Returns which fields were applied and which were rejected and why.",
      DRAFT_PATCH_SCHEMA
    ),
    entry(
      T.createAgent,
      "Create the agent from the current draft. Only when the user asked to create it; the user approves before it runs. Fails if the name or instructions are missing.",
      { type: "object", additionalProperties: false, properties: {} }
    ),
  ]
}

export function isAgentBuilderBuiltinTool(name: string): boolean {
  return TOOLS.has(name)
}

export interface AgentBuilderToolDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  catalogs: () => Promise<DraftCatalogs>
  models: () => Array<{ id: string; name: string }>
  writeDraft: (
    sessionId: string,
    patch: DraftPatch,
    catalogs: DraftCatalogs
  ) => Promise<{
    state: AgentBuilderSessionState
    changed: string[]
    rejected: Array<{ field: string; reason: string }>
  }>
  createAgent: (sessionId: string) => Promise<Character>
}

type ToolError = { ok: false; error: string }
const fail = (error: string): ToolError => ({ ok: false, error })

const CATALOG_LIMIT = 200

function matches(
  query: string | undefined,
  item: { name: string; description?: string; id: string }
) {
  if (!query) return true
  const q = query.toLowerCase()
  return (
    item.name.toLowerCase().includes(q) ||
    item.id.toLowerCase().includes(q) ||
    (item.description ?? "").toLowerCase().includes(q)
  )
}

async function catalogFor(
  kind: CatalogKind,
  query: string | undefined,
  deps: AgentBuilderToolDeps
) {
  if (kind === "models") {
    const models = deps.models().filter((m) => matches(query, m))
    return { kind, items: models.slice(0, CATALOG_LIMIT), total: models.length }
  }
  const catalogs = await deps.catalogs()
  const source =
    kind === "skills"
      ? catalogs.skills
      : kind === "plugin_skills"
        ? catalogs.pluginSkills
        : kind === "mcp_servers"
          ? catalogs.mcpServers
          : catalogs.knowledgeBases
  const items = source.filter((item) => matches(query, item))
  return {
    kind,
    items: items.slice(0, CATALOG_LIMIT).map((item) => ({
      id: item.id,
      name: item.name,
      ...("description" in item && item.description ? { description: item.description } : {}),
      ...("enabled" in item && item.enabled !== undefined ? { enabled: item.enabled } : {}),
    })),
    total: items.length,
  }
}

export async function runAgentBuilderBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: AgentBuilderToolDeps | undefined,
  context: { sessionId: string }
): Promise<unknown> {
  if (!isAgentBuilderBuiltinTool(name)) return fail(`unknown agent builder tool: ${name}`)
  if (!deps) return fail("Agent builder host dependencies are unavailable")
  try {
    const session = await deps.getSession(context.sessionId)
    if (session?.kind !== "agent-builder" || !session.agentBuilder) {
      return fail("These tools only work in an agent builder conversation.")
    }
    if (session.agentBuilder.status === "created" && name !== AGENT_BUILDER_TOOL_NAMES.getDraft) {
      return fail(
        `The agent was already created (id ${session.agentBuilder.createdCharacterId ?? "unknown"}). Further edits happen in its Settings.`
      )
    }
    switch (name) {
      case AGENT_BUILDER_TOOL_NAMES.getDraft: {
        const catalogs = await deps.catalogs()
        return {
          ok: true,
          status: session.agentBuilder.status,
          revision: session.agentBuilder.revision,
          last_edited_by: session.agentBuilder.editedBy,
          draft: renderDraftForModel(session.agentBuilder.draft, catalogs),
        }
      }
      case AGENT_BUILDER_TOOL_NAMES.listCatalog: {
        const kind = args.kind
        if (typeof kind !== "string" || !(CATALOG_KINDS as readonly string[]).includes(kind)) {
          return fail(`kind must be one of ${CATALOG_KINDS.join(", ")}`)
        }
        const query =
          typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined
        return { ok: true, ...(await catalogFor(kind as CatalogKind, query, deps)) }
      }
      case AGENT_BUILDER_TOOL_NAMES.updateDraft: {
        const catalogs = await deps.catalogs()
        const { state, changed, rejected } = await deps.writeDraft(
          context.sessionId,
          args as DraftPatch,
          catalogs
        )
        return {
          ok: rejected.length === 0,
          applied: changed,
          rejected,
          revision: state.revision,
          draft: renderDraftForModel(state.draft, catalogs),
        }
      }
      case AGENT_BUILDER_TOOL_NAMES.createAgent: {
        const agent = await deps.createAgent(context.sessionId)
        return { ok: true, agent_id: agent.id, name: agent.name }
      }
    }
    return fail(`unknown agent builder tool: ${name}`)
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}
