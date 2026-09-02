/**
 * Agent-facing tools for the template platform, saved chat templates and
 * Squads (ADR-0164, the deferred "agent-facing tools" item).
 *
 * ## Why this rides the plugin-tool relay
 *
 * Every store these tools read or write lives in the renderer: the template
 * catalog and service (`lib/templates/runtime.ts`), the Dexie chat-template
 * table (`lib/db/chat-templates.ts`) and the agent-team store. The sidecar
 * cannot import `lib/`, so the tools are manifested through `opts.pluginTools`
 * and executed by `lib/claude/plugin-tool-ipc.ts`, exactly like the artifact
 * tools in `lib/claude/artifact-builtin-tools.ts`.
 *
 * ## Why every write goes through the plugin consent broker
 *
 * `ctx.templates` (`lib/plugin/api/templates-api.ts`) asks the user before any
 * library write, and `ctx.team.saveAsTemplate` was retrofitted onto the same
 * prompt after it turned out to be the one way around it. An agent turn is a
 * third caller of the same writes, so it answers to the same broker under its
 * own synthetic subject: `templates:instantiate` for anything that creates a
 * resource from a template and `templates:library:write` for anything that
 * puts a row in the user's library. The permission tier
 * (`lib/claude/permissions/template-tool-rules.ts`) allows the tools so the
 * user is asked once, by the consent overlay, not twice.
 *
 * ## Why the runner never throws
 *
 * The relay turns a rejection into an opaque transport error, whereas a
 * structured `{ok:false, code}` reaches the model as something it can act on.
 * Same contract as `runArtifactBuiltinTool`.
 */

import type { TemplateRuntime } from "@/lib/templates/runtime"
import type {
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplatePlatform,
} from "@/lib/templates/contracts"
import { TEMPLATE_CATALOG_ONLY_DOMAINS, TEMPLATE_FULL_DOMAINS } from "@/lib/templates/contracts"
import type { TemplatePreflightPlan } from "@/lib/templates/service"
import type { ChatTemplateRow } from "@/lib/db/chat-templates"
import type {
  AddTeammateInput,
  AgentTeam,
  AgentTeamTask,
  AgentTeamTemplate,
  AgentTeammate,
  CreateTaskInput,
  CreateTeamInput,
} from "@/types/agent/agent-team"

export const TEMPLATE_BUILTIN_PLUGIN_ID = "cognia-template-builtin"

export const TEMPLATE_LIST_TOOL_NAME = "template_list"
export const TEMPLATE_GET_TOOL_NAME = "template_get"
export const TEMPLATE_INSTANTIATE_TOOL_NAME = "template_instantiate"
export const CHAT_TEMPLATE_LIST_TOOL_NAME = "chat_template_list"
export const CHAT_TEMPLATE_GET_TOOL_NAME = "chat_template_get"
export const SQUAD_LIST_TOOL_NAME = "squad_list"
export const SQUAD_APPLY_TEMPLATE_TOOL_NAME = "squad_apply_template"
export const SQUAD_SAVE_AS_TEMPLATE_TOOL_NAME = "squad_save_as_template"

/** Tools that only read. Allowed outright by the permission tier. */
export const TEMPLATE_READ_TOOL_NAMES = [
  TEMPLATE_LIST_TOOL_NAME,
  TEMPLATE_GET_TOOL_NAME,
  CHAT_TEMPLATE_LIST_TOOL_NAME,
  CHAT_TEMPLATE_GET_TOOL_NAME,
  SQUAD_LIST_TOOL_NAME,
] as const

/** Tools that create a resource or a library row. Each asks the consent broker. */
export const TEMPLATE_WRITE_TOOL_NAMES = [
  TEMPLATE_INSTANTIATE_TOOL_NAME,
  SQUAD_APPLY_TEMPLATE_TOOL_NAME,
  SQUAD_SAVE_AS_TEMPLATE_TOOL_NAME,
] as const

export const TEMPLATE_TOOL_NAMES = [
  ...TEMPLATE_READ_TOOL_NAMES,
  ...TEMPLATE_WRITE_TOOL_NAMES,
] as const

const ALL_TOOL_NAMES: ReadonlySet<string> = new Set(TEMPLATE_TOOL_NAMES)

export function isTemplateBuiltinTool(name: string): boolean {
  return ALL_TOOL_NAMES.has(name)
}

export interface TemplateManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

/** Ceiling on any listing, so a large library cannot flood a turn. */
export const LIST_MAX_ITEMS = 50

/**
 * Payload and body reads are capped. A template payload pasted whole into the
 * context window is a worse answer than a truncated one plus its length, and
 * the cap also bounds what the relay's PII gate has to scan.
 */
export const READ_CONTENT_MAX_CHARS = 8000

const TEMPLATE_DOMAINS: readonly TemplateDomain[] = [
  ...TEMPLATE_FULL_DOMAINS,
  ...TEMPLATE_CATALOG_ONLY_DOMAINS,
]

const SQUAD_TEMPLATE_CATEGORIES: readonly AgentTeamTemplate["category"][] = [
  "review",
  "research",
  "development",
  "debugging",
  "analysis",
  "general",
  "documentation",
  "security",
]

export function buildTemplateManifestEntries(): TemplateManifestEntry[] {
  return [
    {
      name: TEMPLATE_LIST_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "List templates in the user's unified template catalog: squads, workflows, subagents, custom modes, characters, skills and the catalog-only domains. Filter by `domain` or a free-text `query`. Returns ids, names, domains and versions, capped at 50 rows.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          domain: { type: "string", enum: [...TEMPLATE_DOMAINS] },
          query: { type: "string", maxLength: 200 },
        },
      },
    },
    {
      name: TEMPLATE_GET_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "Read one template definition by id (optionally a specific `version`): metadata, declared inputs, dependencies, capabilities, compatible platforms, and a truncated view of its payload.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
        },
      },
    },
    {
      name: TEMPLATE_INSTANTIATE_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "Preflight and instantiate a template from the catalog on this device, creating the resource it describes (a squad, workflow, subagent, mode, character or skill). Pass `bindings` for any declared input slots. The user is asked to confirm before anything is created, and a blocked preflight is returned with its reasons instead of creating anything.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: { type: "string", minLength: 1 },
          version: { type: "string", minLength: 1 },
          bindings: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Input slot id to resource id, for the template's declared inputs.",
          },
        },
      },
    },
    {
      name: CHAT_TEMPLATE_LIST_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "List the user's saved chat templates (reusable message bodies with `{{parameter}}` tokens), most recently used first. Optional free-text `query` matches name and description.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { query: { type: "string", maxLength: 200 } },
      },
    },
    {
      name: CHAT_TEMPLATE_GET_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "Read one saved chat template by id: its body, declared parameters, launch configuration and the values used last time.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: { id: { type: "string", minLength: 1 } },
      },
    },
    {
      name: SQUAD_LIST_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "List the user's Squads (agent teams) with status, task and teammates, plus the squad templates available to apply. Filter squads by `status`.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: {
            type: "string",
            enum: ["idle", "planning", "executing", "paused", "completed", "failed", "cancelled"],
          },
        },
      },
    },
    {
      name: SQUAD_APPLY_TEMPLATE_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "Create a new Squad from a squad template (use `squad_list` to see template ids). Goes through the template platform so the squad records its lineage. The user is asked to confirm before the squad is created.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["templateId"],
        properties: { templateId: { type: "string", minLength: 1 } },
      },
    },
    {
      name: SQUAD_SAVE_AS_TEMPLATE_TOOL_NAME,
      pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
      description:
        "Save an existing Squad as a reusable squad template in the user's library, mirrored into the unified template catalog. The user is asked to confirm before the library row is written.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["teamId", "name"],
        properties: {
          teamId: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1, maxLength: 120 },
          category: { type: "string", enum: [...SQUAD_TEMPLATE_CATEGORIES] },
        },
      },
    },
  ]
}

export interface TemplateToolContext {
  sessionId: string
}

/** The consent permissions a write tool asks the broker for. */
export type TemplateToolConsentPermission = "templates:instantiate" | "templates:library:write"

export interface TemplateToolSquadDeps {
  teams: () => Record<string, AgentTeam>
  teammates: (teamId: string) => AgentTeammate[]
  templates: () => Record<string, AgentTeamTemplate>
  createTeam: (input: CreateTeamInput) => AgentTeam
  addTeammate: (input: AddTeammateInput) => AgentTeammate
  createTask: (input: CreateTaskInput) => AgentTeamTask
  saveAsTemplate: (
    teamId: string,
    name: string,
    category?: AgentTeamTemplate["category"]
  ) => AgentTeamTemplate | null
}

export interface TemplateToolDeps {
  runtime: TemplateRuntime
  /** Which platform the preflight is evaluated for. */
  platform: TemplatePlatform
  /**
   * Ask the user. Resolves `true` when the write may proceed. Production
   * routes this through `getPluginConsentBroker().request(...)` under
   * {@link TEMPLATE_BUILTIN_PLUGIN_ID}, the same prompt `ctx.templates` uses.
   */
  consent: (permission: TemplateToolConsentPermission, reason: string) => Promise<boolean>
  chatTemplates: {
    list: () => Promise<ChatTemplateRow[]>
    get: (id: string) => Promise<ChatTemplateRow | undefined>
  }
  squads: TemplateToolSquadDeps
  /**
   * Create a squad from a template through the platform. Production binds
   * `applySquadTemplate` from `lib/agent-team/apply-squad-template.ts`.
   */
  applySquadTemplate: (input: {
    template: AgentTeamTemplate
    platform: TemplatePlatform
    actions: Pick<TemplateToolSquadDeps, "createTeam" | "addTeammate" | "createTask">
    runtime: TemplateRuntime
  }) => Promise<{
    teamId: string
    via: "platform" | "legacy"
  }>
  /**
   * Mirror a freshly saved squad template into the unified catalog. Production
   * binds `publishSquadTemplateToPlatform`. Non-fatal, like the plugin path.
   */
  publishSquadTemplate: (template: AgentTeamTemplate) => Promise<unknown>
}

/** Resolve the renderer-side singletons the runner reads and writes through. */
export async function resolveTemplateToolDeps(): Promise<TemplateToolDeps> {
  const [
    { getTemplateRuntime },
    { detectPlatform },
    { getPluginConsentBroker },
    chatTemplates,
    { useAgentTeamStore },
    { applySquadTemplate },
    { publishSquadTemplateToPlatform },
  ] = await Promise.all([
    import("@/lib/templates/runtime"),
    import("@/lib/platform/detect"),
    import("@/lib/plugin/security/consent-broker"),
    import("@/lib/db/chat-templates"),
    import("@/stores/agent/agent-team-store"),
    import("@/lib/agent-team/apply-squad-template"),
    import("@/lib/agent-team/publish-template-to-platform"),
  ])
  const platform = detectPlatform()
  const store = () => useAgentTeamStore.getState()
  return {
    runtime: getTemplateRuntime(),
    platform: platform === "tauri" ? "desktop" : platform === "mobile" ? "mobile" : "web",
    consent: (permission, reason) =>
      getPluginConsentBroker().request({
        pluginId: TEMPLATE_BUILTIN_PLUGIN_ID,
        permission,
        reason,
      }),
    chatTemplates: {
      list: () => chatTemplates.listChatTemplates(),
      get: (id) => chatTemplates.getChatTemplate(id),
    },
    squads: {
      teams: () => store().teams,
      teammates: (teamId) => store().getTeammates(teamId),
      templates: () => store().templates,
      createTeam: (input) => store().createTeam(input),
      addTeammate: (input) => store().addTeammate(input),
      createTask: (input) => store().createTask(input),
      saveAsTemplate: (teamId, name, category) => store().saveAsTemplate(teamId, name, category),
    },
    applySquadTemplate: (input) => applySquadTemplate(input),
    publishSquadTemplate: (template) => publishSquadTemplateToPlatform(template),
  }
}

type Failure = {
  ok: false
  code: string
  error: string
  issues?: unknown
}

function invalidArguments(error: string): Failure {
  return { ok: false, code: "invalid_arguments", error }
}

function notFound(kind: string, id: string): Failure {
  return { ok: false, code: "not_found", error: `no ${kind} with id ${id}` }
}

function denied(what: string): Failure {
  return { ok: false, code: "consent_denied", error: `the user declined to ${what}` }
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value : null
}

function truncate(content: string): {
  content: string
  truncated: boolean
  length: number
} {
  if (content.length <= READ_CONTENT_MAX_CHARS) {
    return { content, truncated: false, length: content.length }
  }
  return {
    content: content.slice(0, READ_CONTENT_MAX_CHARS),
    truncated: true,
    length: content.length,
  }
}

function definitionSummary(definition: TemplateDefinitionEnvelope) {
  return {
    id: definition.id,
    name: definition.metadata.name,
    domain: definition.domain,
    status: definition.status,
    version: definition.version,
    ...(definition.metadata.description ? { description: definition.metadata.description } : {}),
    ...(definition.metadata.category ? { category: definition.metadata.category } : {}),
    source: definition.provenance.source,
    platforms: definition.compatibility.platforms,
  }
}

function chatTemplateSummary(row: ChatTemplateRow) {
  return {
    id: row.id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    parameters: row.params.map((param) => ({
      id: param.id,
      label: param.label,
      required: param.required,
      kind: param.kind,
    })),
    usageCount: row.usageCount,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt } : {}),
  }
}

function squadSummary(team: AgentTeam, teammates: AgentTeammate[]) {
  return {
    teamId: team.id,
    name: team.name,
    status: team.status,
    task: team.task,
    ...(team.projectId ? { projectId: team.projectId } : {}),
    teammates: teammates.map((mate) => ({
      teammateId: mate.id,
      name: mate.name,
      role: mate.role,
      status: mate.status,
    })),
  }
}

function squadTemplateSummary(template: AgentTeamTemplate) {
  return {
    templateId: template.id,
    name: template.name,
    description: template.description,
    category: template.category,
    teammates: template.teammates.map((mate) => mate.name),
    ...(template.isBuiltIn ? { builtIn: true } : {}),
  }
}

function blocked(plan: TemplatePreflightPlan): Failure {
  return {
    ok: false,
    code: "preflight_blocked",
    error: plan.issues.map((issue) => issue.message).join(", ") || "template preflight was blocked",
    issues: plan.issues.map((issue) => ({ code: issue.code, message: issue.message })),
  }
}

function bindingsFrom(args: Record<string, unknown>): Record<string, string> | Failure {
  const raw = args.bindings
  if (raw === undefined) return {}
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidArguments("bindings must be an object of slot id to resource id")
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      return invalidArguments(`binding ${key} must be a string`)
    }
    out[key] = value
  }
  return out
}

function isFailure(value: unknown): value is Failure {
  return !!value && typeof value === "object" && (value as { ok?: unknown }).ok === false
}

/**
 * Execute one template, chat-template or squad tool call. Never throws.
 */
export async function runTemplateBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: TemplateToolDeps,
  _context: TemplateToolContext
): Promise<unknown> {
  try {
    switch (name) {
      case TEMPLATE_LIST_TOOL_NAME: {
        const domain = str(args, "domain") as TemplateDomain | null
        if (domain && !TEMPLATE_DOMAINS.includes(domain)) {
          return invalidArguments(`domain must be one of ${TEMPLATE_DOMAINS.join(", ")}`)
        }
        const query = str(args, "query") ?? undefined
        const rows = deps.runtime.catalog.query({
          ...(domain ? { domain } : {}),
          ...(query ? { text: query } : {}),
        })
        return {
          ok: true as const,
          templates: rows.slice(0, LIST_MAX_ITEMS).map(definitionSummary),
          total: rows.length,
          truncated: rows.length > LIST_MAX_ITEMS,
        }
      }

      case TEMPLATE_GET_TOOL_NAME: {
        const id = str(args, "id")
        if (!id) return invalidArguments("id is required")
        const version = str(args, "version")
        const definition = deps.runtime.catalog.get(id, version ?? undefined)
        if (!definition) return notFound("template", version ? `${id}@${version}` : id)
        const payload = truncate(JSON.stringify(definition.payload, null, 2))
        return {
          ok: true as const,
          ...definitionSummary(definition),
          revision: definition.revision,
          inputs: definition.inputs,
          dependencies: definition.dependencies,
          capabilities: definition.capabilities,
          compatibility: definition.compatibility,
          ...(definition.metadata.tags?.length ? { tags: definition.metadata.tags } : {}),
          payload: payload.content,
          payloadLength: payload.length,
          truncated: payload.truncated,
        }
      }

      case TEMPLATE_INSTANTIATE_TOOL_NAME: {
        const id = str(args, "id")
        if (!id) return invalidArguments("id is required")
        const version = str(args, "version")
        const bindings = bindingsFrom(args)
        if (isFailure(bindings)) return bindings
        const definition = deps.runtime.catalog.get(id, version ?? undefined)
        if (!definition) return notFound("template", version ? `${id}@${version}` : id)
        if (!(TEMPLATE_FULL_DOMAINS as readonly string[]).includes(definition.domain)) {
          return {
            ok: false as const,
            code: "catalog_only",
            error: `templates in the ${definition.domain} domain can be read but not instantiated`,
          }
        }
        // Preflight first so a blocked plan never costs the user a prompt.
        const plan = await deps.runtime.service.preflight({
          definitionId: definition.id,
          ...(definition.version ? { version: definition.version } : {}),
          platform: deps.platform,
          bindings,
        })
        if (plan.status === "blocked") return blocked(plan)
        // The consent prompt IS the explicit confirmation the service demands
        // for a `needs-confirmation` plan, so `confirmed` is the user's answer,
        // never a constant.
        const confirmed = await deps.consent(
          "templates:instantiate",
          `instantiate:${definition.id}`
        )
        if (!confirmed) return denied(`instantiate template ${definition.id}`)
        const result = await deps.runtime.service.instantiate({ plan, confirmed })
        return {
          ok: true as const,
          ...definitionSummary(definition),
          resources: result.resources,
          warnings: plan.issues.filter((issue) => issue.severity === "warning"),
        }
      }

      case CHAT_TEMPLATE_LIST_TOOL_NAME: {
        const query = str(args, "query")?.toLocaleLowerCase()
        const rows = (await deps.chatTemplates.list()).filter((row) => {
          if (!query) return true
          return `${row.name} ${row.description ?? ""}`.toLocaleLowerCase().includes(query)
        })
        return {
          ok: true as const,
          templates: rows.slice(0, LIST_MAX_ITEMS).map(chatTemplateSummary),
          total: rows.length,
          truncated: rows.length > LIST_MAX_ITEMS,
        }
      }

      case CHAT_TEMPLATE_GET_TOOL_NAME: {
        const id = str(args, "id")
        if (!id) return invalidArguments("id is required")
        const row = await deps.chatTemplates.get(id)
        if (!row) return notFound("chat template", id)
        const body = truncate(row.body)
        return {
          ok: true as const,
          ...chatTemplateSummary(row),
          body: body.content,
          bodyLength: body.length,
          truncated: body.truncated,
          revision: row.revision,
          parameters: row.params,
          ...(row.launchSpec ? { launchSpec: row.launchSpec } : {}),
          ...(row.lastParams ? { lastParams: row.lastParams } : {}),
        }
      }

      case SQUAD_LIST_TOOL_NAME: {
        const status = str(args, "status")
        const teams = Object.values(deps.squads.teams()).filter(
          (team) => !status || team.status === status
        )
        const templates = Object.values(deps.squads.templates())
        return {
          ok: true as const,
          squads: teams
            .slice(0, LIST_MAX_ITEMS)
            .map((team) => squadSummary(team, deps.squads.teammates(team.id))),
          total: teams.length,
          truncated: teams.length > LIST_MAX_ITEMS,
          templates: templates.slice(0, LIST_MAX_ITEMS).map(squadTemplateSummary),
        }
      }

      case SQUAD_APPLY_TEMPLATE_TOOL_NAME: {
        const templateId = str(args, "templateId")
        if (!templateId) return invalidArguments("templateId is required")
        const template = deps.squads.templates()[templateId]
        if (!template) return notFound("squad template", templateId)
        const confirmed = await deps.consent("templates:instantiate", `instantiate:${template.id}`)
        if (!confirmed) return denied(`create a squad from template ${template.id}`)
        const result = await deps.applySquadTemplate({
          template,
          platform: deps.platform,
          actions: {
            createTeam: deps.squads.createTeam,
            addTeammate: deps.squads.addTeammate,
            createTask: deps.squads.createTask,
          },
          runtime: deps.runtime,
        })
        const team = deps.squads.teams()[result.teamId]
        return {
          ok: true as const,
          teamId: result.teamId,
          via: result.via,
          ...(team ? { name: team.name, status: team.status } : {}),
          templateId: template.id,
        }
      }

      case SQUAD_SAVE_AS_TEMPLATE_TOOL_NAME: {
        const teamId = str(args, "teamId")
        const templateName = str(args, "name")
        if (!teamId || !templateName) return invalidArguments("teamId and name are required")
        const category = str(args, "category") as AgentTeamTemplate["category"] | null
        if (category && !SQUAD_TEMPLATE_CATEGORIES.includes(category)) {
          return invalidArguments(`category must be one of ${SQUAD_TEMPLATE_CATEGORIES.join(", ")}`)
        }
        if (!deps.squads.teams()[teamId]) return notFound("squad", teamId)
        // Consent BEFORE the store write, so a refusal leaves nothing behind.
        // Same order and same permission as `ctx.team.saveAsTemplate`.
        const confirmed = await deps.consent(
          "templates:library:write",
          `library-write:${templateName}`
        )
        if (!confirmed) return denied(`save squad ${teamId} as a template`)
        const template = deps.squads.saveAsTemplate(teamId, templateName, category ?? undefined)
        if (!template) return notFound("squad", teamId)
        // Same write-time mirror the plugin API performs. Non-fatal: the legacy
        // store is still the read side.
        let mirrored = true
        await deps.publishSquadTemplate(template).catch(() => {
          mirrored = false
        })
        return {
          ok: true as const,
          ...squadTemplateSummary(template),
          mirroredToCatalog: mirrored,
        }
      }

      default:
        return invalidArguments(`unknown template tool ${name}`)
    }
  } catch (err) {
    return {
      ok: false as const,
      code: "tool_failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
