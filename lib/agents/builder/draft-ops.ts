/**
 * The agent draft the conversational builder edits (ADR-0220), as pure
 * operations: apply a tool's patch, check it against the catalogs it names,
 * validate it with the editor's own rules, and render it for the model.
 *
 * The builder speaks a deliberately narrower vocabulary than the form: who the
 * agent is, how it behaves, what it carries. Machine-bound settings (working
 * directory, sandbox, account, computer-use target, environment secrets) are
 * the person's to set in the draft panel. The two permission modes that skip
 * approvals are never settable by the builder: an agent may not grant itself,
 * or the agent it is building, the right to act unasked.
 */

import type { AgentBuilderDraft, AgentMemoryPolicy, AppSettings } from "@cognia/agent-config-types"
import {
  characterToEditorState,
  validateEditorState,
  type EditorValidationIssue,
} from "@/lib/agents/editor-state"

export const DRAFT_NAME_MAX = 80
export const DRAFT_DESCRIPTION_MAX = 255
export const DRAFT_INSTRUCTIONS_MAX = 20_000
export const DRAFT_STARTERS_MAX = 3
export const DRAFT_STARTER_MAX = 200

/** Permission modes the builder may propose. `bypassPermissions` and `dontAsk` are the person's call. */
export const BUILDER_PERMISSION_MODES = ["default", "acceptEdits", "plan", "auto"] as const
type BuilderPermissionMode = (typeof BUILDER_PERMISSION_MODES)[number]

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

/** What the draft's ids may point at. */
export interface DraftCatalogs {
  skills: ReadonlyArray<{ id: string; name: string; description?: string }>
  pluginSkills: ReadonlyArray<{ id: string; name: string; description?: string }>
  mcpServers: ReadonlyArray<{ id: string; name: string; enabled?: boolean; transport?: string }>
  knowledgeBases: ReadonlyArray<{ id: string; name: string; description?: string }>
}

/** The builder tool's patch, in the snake_case the model is given. */
export interface DraftPatch {
  name?: string
  description?: string
  avatar_emoji?: string
  avatar_color?: string
  instructions?: string
  persona_tone?: string
  persona_personality?: string
  opening_message?: string
  conversation_starters?: string[]
  skill_ids?: string[]
  plugin_skill_ids?: string[]
  /** `null` means "every enabled MCP server". */
  mcp_server_ids?: string[] | null
  knowledge_base_ids?: string[]
  model?: string
  plan_model?: string
  utility_model?: string
  permission_mode?: BuilderPermissionMode | "inherit"
  effort?: (typeof EFFORTS)[number] | "inherit"
  /** `null` clears it. */
  max_turns?: number | null
  allowed_tools?: string[]
  disallowed_tools?: string[]
  enable_browser_tools?: boolean
  enable_computer_use?: boolean
  brief_mode?: boolean
  memory?: Partial<{
    recall: boolean
    create: boolean
    update: boolean
    forget: boolean
    auto_learn: boolean
  }>
}

export interface DraftPatchResult {
  draft: AgentBuilderDraft
  /** Fields changed, in patch order. */
  changed: string[]
  /** Fields refused, with why; the rest of the patch still applies. */
  rejected: Array<{ field: string; reason: string }>
}

const DEFAULT_MEMORY_POLICY: AgentMemoryPolicy = {
  operations: { recall: true, create: true, update: true, forget: true },
  readableScopes: ["global", "workspace", "character", "agent"],
  writableScopes: ["global", "workspace", "character", "agent"],
  autoLearn: true,
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return [
    ...new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim())),
  ].filter(Boolean)
}

function checkIds(
  field: string,
  ids: string[],
  catalog: ReadonlyArray<{ id: string }>,
  rejected: DraftPatchResult["rejected"]
): string[] | undefined {
  const known = new Set(catalog.map((item) => item.id))
  const unknown = ids.filter((id) => !known.has(id))
  if (unknown.length > 0) {
    rejected.push({
      field,
      reason: `unknown id(s): ${unknown.join(", ")}. Call agent_builder_list_catalog for the valid ids.`,
    })
    return undefined
  }
  return ids
}

/**
 * Apply a builder patch. Each field is checked on its own: a bad skill id
 * rejects `skill_ids` and nothing else, and the result says which fields
 * landed and which did not, so the model can correct only what failed.
 */
export function applyDraftPatch(
  current: AgentBuilderDraft,
  patch: DraftPatch,
  catalogs: DraftCatalogs
): DraftPatchResult {
  const draft: AgentBuilderDraft = { ...current }
  const changed: string[] = []
  const rejected: DraftPatchResult["rejected"] = []
  const set = (field: string, apply: () => void) => {
    apply()
    changed.push(field)
  }

  const name = text(patch.name)
  if (name !== undefined) {
    if (name.length > DRAFT_NAME_MAX)
      rejected.push({ field: "name", reason: `longer than ${DRAFT_NAME_MAX} characters` })
    else set("name", () => (draft.name = name))
  }
  const description = text(patch.description)
  if (description !== undefined) {
    if (description.length > DRAFT_DESCRIPTION_MAX) {
      rejected.push({
        field: "description",
        reason: `longer than ${DRAFT_DESCRIPTION_MAX} characters`,
      })
    } else set("description", () => (draft.description = description || undefined))
  }
  const emoji = text(patch.avatar_emoji)
  if (emoji !== undefined) {
    if ([...emoji].length > 4)
      rejected.push({ field: "avatar_emoji", reason: "use a single emoji" })
    else set("avatar_emoji", () => (draft.avatarEmoji = emoji || undefined))
  }
  const color = text(patch.avatar_color)
  if (color) set("avatar_color", () => (draft.avatarColor = color))
  if (typeof patch.instructions === "string") {
    if (patch.instructions.length > DRAFT_INSTRUCTIONS_MAX) {
      rejected.push({
        field: "instructions",
        reason: `longer than ${DRAFT_INSTRUCTIONS_MAX} characters`,
      })
    } else set("instructions", () => (draft.systemPrompt = patch.instructions))
  }

  const personaPatch: Record<string, unknown> = {}
  const tone = text(patch.persona_tone)
  if (tone !== undefined) personaPatch.tone = tone || undefined
  const personality = text(patch.persona_personality)
  if (personality !== undefined) personaPatch.personality = personality || undefined
  const opening = text(patch.opening_message)
  if (opening !== undefined) personaPatch.openingMessage = opening || undefined
  const starters = stringList(patch.conversation_starters)
  if (starters !== undefined) {
    if (starters.length > DRAFT_STARTERS_MAX) {
      rejected.push({ field: "conversation_starters", reason: `at most ${DRAFT_STARTERS_MAX}` })
    } else if (starters.some((s) => s.length > DRAFT_STARTER_MAX)) {
      rejected.push({
        field: "conversation_starters",
        reason: `each at most ${DRAFT_STARTER_MAX} characters`,
      })
    } else personaPatch.exemplarPrompts = starters.length > 0 ? starters : undefined
  }
  if (Object.keys(personaPatch).length > 0) {
    const persona = { ...(draft.persona ?? {}), ...personaPatch }
    const hasAny = Object.values(persona).some((v) => v !== undefined)
    set(
      "persona",
      () => (draft.persona = hasAny ? (persona as AgentBuilderDraft["persona"]) : undefined)
    )
  }

  const skillIds = stringList(patch.skill_ids)
  if (skillIds !== undefined) {
    const ok = checkIds("skill_ids", skillIds, catalogs.skills, rejected)
    if (ok) set("skill_ids", () => (draft.skillIds = ok.length > 0 ? ok : undefined))
  }
  const pluginSkillIds = stringList(patch.plugin_skill_ids)
  if (pluginSkillIds !== undefined) {
    const ok = checkIds("plugin_skill_ids", pluginSkillIds, catalogs.pluginSkills, rejected)
    if (ok) set("plugin_skill_ids", () => (draft.pluginSkillIds = ok))
  }
  if (patch.mcp_server_ids === null) {
    set("mcp_server_ids", () => (draft.mcpServerIds = undefined))
  } else {
    const mcp = stringList(patch.mcp_server_ids)
    if (mcp !== undefined) {
      const ok = checkIds("mcp_server_ids", mcp, catalogs.mcpServers, rejected)
      if (ok) set("mcp_server_ids", () => (draft.mcpServerIds = ok.length > 0 ? ok : undefined))
    }
  }
  const kbIds = stringList(patch.knowledge_base_ids)
  if (kbIds !== undefined) {
    const ok = checkIds("knowledge_base_ids", kbIds, catalogs.knowledgeBases, rejected)
    if (ok)
      set("knowledge_base_ids", () => (draft.knowledgeBaseIds = ok.length > 0 ? ok : undefined))
  }

  const execute = text(patch.model)
  const plan = text(patch.plan_model)
  const utility = text(patch.utility_model)
  if (execute !== undefined || plan !== undefined || utility !== undefined) {
    const routing = { ...(draft.modelRouting ?? {}) }
    if (execute !== undefined) routing.execute = execute || undefined
    if (plan !== undefined) routing.plan = plan || undefined
    if (utility !== undefined) routing.utility = utility || undefined
    const any = routing.execute || routing.plan || routing.utility
    set("model", () => {
      draft.modelRouting = any ? routing : undefined
      draft.model = routing.execute
    })
  }

  if (patch.permission_mode !== undefined) {
    if (patch.permission_mode === "inherit") {
      set("permission_mode", () => (draft.permissionMode = undefined))
    } else if ((BUILDER_PERMISSION_MODES as readonly string[]).includes(patch.permission_mode)) {
      set(
        "permission_mode",
        () => (draft.permissionMode = patch.permission_mode as AppSettings["permissionMode"])
      )
    } else {
      rejected.push({
        field: "permission_mode",
        reason: `must be one of ${BUILDER_PERMISSION_MODES.join(", ")} or inherit; modes that skip approvals are set by the user`,
      })
    }
  }

  if (patch.effort !== undefined || patch.max_turns !== undefined) {
    const policy = { ...(draft.executionPolicy ?? {}) }
    let ok = true
    if (patch.effort !== undefined) {
      if (patch.effort === "inherit") policy.effort = undefined
      else if ((EFFORTS as readonly string[]).includes(patch.effort)) policy.effort = patch.effort
      else {
        ok = false
        rejected.push({
          field: "effort",
          reason: `must be one of ${EFFORTS.join(", ")} or inherit`,
        })
      }
    }
    if (patch.max_turns !== undefined) {
      if (patch.max_turns === null) policy.maxTurns = undefined
      else if (
        Number.isInteger(patch.max_turns) &&
        patch.max_turns >= 1 &&
        patch.max_turns <= 100
      ) {
        policy.maxTurns = patch.max_turns
      } else {
        ok = false
        rejected.push({ field: "max_turns", reason: "an integer from 1 to 100, or null" })
      }
    }
    if (ok) {
      const any = policy.effort !== undefined || policy.maxTurns !== undefined || policy.envBindings
      set("execution", () => (draft.executionPolicy = any ? policy : undefined))
    }
  }

  const allowed = stringList(patch.allowed_tools)
  if (allowed !== undefined)
    set("allowed_tools", () => (draft.allowedTools = allowed.length > 0 ? allowed : undefined))
  const denied = stringList(patch.disallowed_tools)
  if (denied !== undefined)
    set("disallowed_tools", () => (draft.disallowedTools = denied.length > 0 ? denied : undefined))
  if (typeof patch.enable_browser_tools === "boolean") {
    set(
      "enable_browser_tools",
      () => (draft.enableBrowserTools = patch.enable_browser_tools || undefined)
    )
  }
  if (typeof patch.enable_computer_use === "boolean") {
    set(
      "enable_computer_use",
      () => (draft.enableComputerUse = patch.enable_computer_use || undefined)
    )
  }
  if (typeof patch.brief_mode === "boolean") {
    set("brief_mode", () => (draft.briefMode = patch.brief_mode || undefined))
  }

  if (patch.memory && typeof patch.memory === "object") {
    const base = draft.memoryPolicy ?? DEFAULT_MEMORY_POLICY
    const m = patch.memory
    const pick = (value: unknown, fallback: boolean) =>
      typeof value === "boolean" ? value : fallback
    set("memory", () => {
      draft.memoryPolicy = {
        ...base,
        operations: {
          recall: pick(m.recall, base.operations.recall),
          create: pick(m.create, base.operations.create),
          update: pick(m.update, base.operations.update),
          forget: pick(m.forget, base.operations.forget),
        },
        autoLearn: pick(m.auto_learn, base.autoLearn),
      }
    })
  }

  return { draft, changed, rejected }
}

/** True for a draft nobody has written anything into yet. */
export function isDraftEmpty(draft: AgentBuilderDraft): boolean {
  return Object.values(draft).every(
    (value) => value === undefined || value === "" || (Array.isArray(value) && value.length === 0)
  )
}

/** What still stops the draft from becoming an agent, with the form's own rules. */
export function draftIssues(draft: AgentBuilderDraft): EditorValidationIssue[] {
  const issue = validateEditorState(characterToEditorState(draft))
  return issue ? [issue] : []
}

/**
 * The draft as the model sees it: profile fields only, ids paired with
 * names so it can talk about them, and what is still missing.
 */
export function renderDraftForModel(draft: AgentBuilderDraft, catalogs: DraftCatalogs) {
  const named = (
    ids: readonly string[] | undefined,
    catalog: ReadonlyArray<{ id: string; name: string }>
  ) => (ids ?? []).map((id) => ({ id, name: catalog.find((item) => item.id === id)?.name ?? null }))
  return {
    name: draft.name ?? "",
    description: draft.description ?? "",
    avatar_emoji: draft.avatarEmoji ?? "",
    avatar_color: draft.avatarColor ?? "",
    instructions: draft.systemPrompt ?? "",
    persona_tone: draft.persona?.tone ?? "",
    persona_personality: draft.persona?.personality ?? "",
    opening_message: draft.persona?.openingMessage ?? "",
    conversation_starters: draft.persona?.exemplarPrompts ?? [],
    skills: named(draft.skillIds, catalogs.skills),
    plugin_skills: named(draft.pluginSkillIds, catalogs.pluginSkills),
    mcp_servers:
      draft.mcpServerIds === undefined
        ? "all-enabled"
        : named(draft.mcpServerIds, catalogs.mcpServers),
    knowledge_bases: named(draft.knowledgeBaseIds, catalogs.knowledgeBases),
    model: draft.modelRouting?.execute ?? draft.model ?? "",
    plan_model: draft.modelRouting?.plan ?? "",
    utility_model: draft.modelRouting?.utility ?? "",
    permission_mode: draft.permissionMode ?? "inherit",
    effort: draft.executionPolicy?.effort ?? "inherit",
    max_turns: draft.executionPolicy?.maxTurns ?? null,
    allowed_tools: draft.allowedTools ?? [],
    disallowed_tools: draft.disallowedTools ?? [],
    enable_browser_tools: draft.enableBrowserTools === true,
    enable_computer_use: draft.enableComputerUse === true,
    brief_mode: draft.briefMode === true,
    memory: draft.memoryPolicy
      ? {
          ...draft.memoryPolicy.operations,
          auto_learn: draft.memoryPolicy.autoLearn,
        }
      : "default",
    runtime: draft.runtime ?? "app-default",
    missing: draftIssues(draft).map((issue) => issue.code),
  }
}
