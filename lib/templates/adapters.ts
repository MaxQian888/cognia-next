import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import { isCredentialKey } from "./contracts"
import { interpolateTemplatePayload, resolveTemplateInputs } from "./interpolate"
import type {
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplateJson,
  TemplateValidationIssue,
} from "./contracts"
import type {
  TemplateDiffResult,
  TemplateDomainAdapter,
  TemplateInstantiationResult,
  TemplatePreflightPlan,
} from "./service"

export interface AgentTeamProjectionInput {
  team: AgentTeam
  teammates: AgentTeammate[]
  tasks: AgentTeamTask[]
}

/**
 * Declared as `type` aliases rather than `interface`es on purpose.
 *
 * A template payload has to satisfy `TemplateJson` (it is persisted and shipped
 * as JSON), and `TemplateJson`'s object arm is an index signature. TypeScript
 * only derives an *implicit* index signature for object-literal type aliases —
 * an `interface` never gets one, so `interface AgentTeamTwinSlot {...}` is not
 * assignable to `{ [key: string]: TemplateJson }` no matter how JSON-shaped its
 * fields are. Writing these as `interface`s is what made the whole payload
 * chain (this file, `legacy-sources.ts`, `template-studio.tsx`) fail to compile.
 *
 * `AgentTeamTemplatePayload` also no longer says `extends Record<string,
 * TemplateJson>`: with a type alias the constraint is satisfied structurally,
 * and the explicit `extends` additionally demanded that every *declared*
 * property be a `TemplateJson`, which optional properties are not.
 */
export type AgentTeamTwinSlot = {
  id: string
  label: string
  required: boolean
  scope: "team" | "teammate"
}

export type AgentTeamTemplatePayload = {
  team: {
    name: string
    description: string
    task: string
    config: Record<string, TemplateJson>
  }
  lead: {
    localId: string
    name: string
    description: string
    config: Record<string, TemplateJson>
    twinSlotId?: string
  }
  teammates: Array<{
    localId: string
    name: string
    description: string
    role?: string
    specialization?: string
    config: Record<string, TemplateJson>
    spawnPrompt?: string
    capabilities?: TemplateJson
    governanceHints?: TemplateJson
    tags?: string[]
    iconKey?: string
    twinSlotId?: string
  }>
  tasks: Array<{
    localId: string
    title: string
    description: string
    priority: string
    assignedToLocalId?: string
    dependencies: string[]
    tags: string[]
    expectedOutput?: string
    estimatedDuration?: number
    order: number
    metadata?: TemplateJson
  }>
  twinSlots: AgentTeamTwinSlot[]
}

export interface AgentTeamTemplatePort {
  createTeam(
    input: Record<string, unknown>
  ): { id: string; leadId?: string } | Promise<{ id: string; leadId?: string }>
  addTeammate(input: Record<string, unknown>): { id: string } | Promise<{ id: string }>
  createTask(input: Record<string, unknown>): { id: string } | Promise<{ id: string }>
  deleteTeam(teamId: string): void | Promise<void>
  updateTeammate?(teammateId: string, patch: Record<string, unknown>): void | Promise<void>
  snapshot(resourceIds: Array<{ domain: string; id: string }>): TemplateJson | Promise<TemplateJson>
  update?(
    resourceIds: Array<{ domain: string; id: string }>,
    payload: TemplateJson
  ): TemplateInstantiationResult | Promise<TemplateInstantiationResult>
  isActive?(resourceIds: Array<{ domain: string; id: string }>): boolean | Promise<boolean>
}

export interface CrudTemplatePort {
  create(
    payload: TemplateJson,
    bindings: Readonly<Record<string, string>>
  ): { id: string } | Promise<{ id: string }>
  snapshot(resourceIds: Array<{ domain: string; id: string }>): TemplateJson | Promise<TemplateJson>
  update?(
    resourceIds: Array<{ domain: string; id: string }>,
    payload: TemplateJson,
    bindings: Readonly<Record<string, string>>
  ): { id: string } | Promise<{ id: string }>
  isActive?(resourceIds: Array<{ domain: string; id: string }>): boolean | Promise<boolean>
}

/**
 * Structurally non-portable keys. Credentials are NOT listed here — they go
 * through `isCredentialKey`, which matches key *stems* rather than exact names.
 * Listing them exactly is what let `AgentTeamConfig.defaultApiKey` survive
 * projection: the set held `apiKey`, the field is `defaultApiKey`, and nothing
 * looked past the first character.
 */
const NON_PORTABLE_KEYS = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "lastUsedAt",
  "usageCount",
  "isBuiltIn",
  "projectId",
  "sessionId",
  "status",
  "published",
  "twinId",
  "knowledgeTwinIds",
  "memoryIds",
  "workingDir",
  "nativeDirectory",
  "localPath",
  "tauriPath",
  "absolutePath",
  "sourcePluginId",
  "sourcePackId",
  "clonedFromPackCharacterId",
  "packVersionAtClone",
  "pristineSnapshot",
])

function toJson(value: unknown): TemplateJson {
  if (value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(toJson)
  if (!value || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return null
    return value as TemplateJson
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .map(([key, nested]) => [key, toJson(nested)])
  )
}

function stripNonPortable(value: unknown, preserveIdentity = false): TemplateJson {
  const json = toJson(value)
  if (Array.isArray(json)) return json.map((item) => stripNonPortable(item, preserveIdentity))
  if (!json || typeof json !== "object") return json
  return Object.fromEntries(
    Object.entries(json)
      .filter(
        ([key]) =>
          (preserveIdentity && key === "id") ||
          (!NON_PORTABLE_KEYS.has(key) && !isCredentialKey(key))
      )
      .map(([key, nested]) => [key, stripNonPortable(nested, preserveIdentity)])
  )
}

export function projectPortableTemplateValue(value: unknown): TemplateJson {
  return stripNonPortable(value)
}

function asObject(value: unknown): Record<string, TemplateJson> {
  const json = stripNonPortable(value)
  return json && typeof json === "object" && !Array.isArray(json) ? json : {}
}

function genericDiff(
  baseline: TemplateJson,
  local: TemplateJson,
  next: TemplateJson
): TemplateDiffResult {
  const baselineText = JSON.stringify(baseline)
  const localText = JSON.stringify(local)
  const nextText = JSON.stringify(next)
  if (baselineText === nextText) return { changes: [], conflicts: [] }
  if (baselineText === localText) {
    return { changes: [{ path: "$", before: baseline, after: next }], conflicts: [] }
  }
  if (localText === nextText) return { changes: [], conflicts: [] }
  return {
    changes: [],
    conflicts: [{ path: "$", baseline, local, next }],
  }
}

function definitionPayload<T extends TemplateJson>(definition: TemplateDefinitionEnvelope): T {
  return definition.payload as T
}

function bindingsFromPlan(plan: TemplatePreflightPlan): Record<string, string> {
  return Object.fromEntries(plan.bindings.map((binding) => [binding.slotId, binding.resourceId]))
}

/**
 * The bindings that may be written INTO a payload.
 *
 * A sensitive binding is deliberately not one of them. The payload is persisted,
 * packaged and shipped — `pushForbiddenPayloadIssues` refuses a credential field
 * in one for exactly that reason — so substituting a secret reference into it
 * would smuggle past that check through the back door. Adapters still receive
 * the full binding map and resolve secrets through the channel built for it.
 */
export function interpolatableBindings(
  bindings: readonly { slotId: string; resourceId: string; sensitive?: boolean }[]
): Record<string, string> {
  return Object.fromEntries(
    bindings.filter((binding) => !binding.sensitive).map((b) => [b.slotId, b.resourceId])
  )
}

/**
 * The payload as it should reach a live resource: `{{inputId}}` replaced by the
 * value the plan bound.
 *
 * Everything around this already worked — the validator rejects a token that
 * names no declared input, preflight blocks a plan whose required inputs are
 * unbound, the Studio collects a value for each — and then the raw payload went
 * to the adapter, so a parameterised template created a resource containing the
 * literal `{{teamName}}`.
 */
function resolvedPayload<T extends TemplateJson>(
  definition: TemplateDefinitionEnvelope,
  bindings: Readonly<Record<string, string>>
): T {
  return interpolateTemplatePayload(
    definition.payload,
    resolveTemplateInputs(definition.inputs, bindings)
  ) as T
}

/**
 * The same, for an update: the values come from what the instance was created
 * with, because an update has no plan of its own to read them from. An instance
 * written before bindings were recorded has none, and its payload goes through
 * untouched — the same behaviour it was created with, which is the only answer
 * that does not silently rewrite a resource on the next version bump.
 */
export function resolvedUpdatePayload<T extends TemplateJson>(
  next: TemplateDefinitionEnvelope,
  instance: { bindings?: Record<string, string> }
): T {
  return resolvedPayload<T>(next, instance.bindings ?? {})
}

function standardPreflight(
  definition: TemplateDefinitionEnvelope,
  bindings: Record<string, string>,
  summary: string
): TemplatePreflightPlan {
  const issues = definition.inputs
    .filter((input) => input.required && !bindings[input.id])
    .map((input) => ({
      code: "binding.required",
      severity: "blocker" as const,
      message: `Required binding "${input.label}" is unresolved`,
      path: `inputs.${input.id}`,
    }))
  const resolved = definition.inputs
    .filter((input) => bindings[input.id])
    .map((input) => ({
      slotId: input.id,
      kind: input.kind,
      resourceId: bindings[input.id],
      sensitive: input.kind === "secretRef" || input.kind === "twinSlot",
    }))
  const requiresConfirmation = resolved.some((binding) => binding.sensitive)
  return {
    definitionId: definition.id,
    definitionHash: definition.contentHash,
    status: issues.length > 0 ? "blocked" : requiresConfirmation ? "needs-confirmation" : "ready",
    bindings: resolved,
    issues,
    operations: [
      {
        id: `create:${definition.id}`,
        kind: "create",
        domain: definition.domain,
        summary,
      },
    ],
    requiresConfirmation,
  }
}

function taskOrder(tasks: AgentTeamTemplatePayload["tasks"]): AgentTeamTemplatePayload["tasks"] {
  const byId = new Map(tasks.map((task) => [task.localId, task]))
  const result: AgentTeamTemplatePayload["tasks"] = []
  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`AgentTeam task dependency cycle at ${id}`)
    if (visited.has(id)) return
    const task = byId.get(id)
    if (!task) return
    visiting.add(id)
    for (const dependency of task.dependencies) visit(dependency)
    visiting.delete(id)
    visited.add(id)
    result.push(task)
  }
  for (const task of [...tasks].sort((a, b) => a.order - b.order)) visit(task.localId)
  return result
}

export function createAgentTeamTemplateAdapter(port: AgentTeamTemplatePort): TemplateDomainAdapter {
  return {
    domain: "agentTeam",

    async project(resource) {
      const { team, teammates, tasks } = resource as AgentTeamProjectionInput
      const lead = teammates.find((teammate) => teammate.id === team.leadId)
      if (!lead) throw new Error("AgentTeam projection requires its lead")
      const twinSlots: AgentTeamTwinSlot[] = []
      const leadTwinSlotId = lead.config.twinId ? `teammate.${lead.id}.twin` : undefined
      if (leadTwinSlotId) {
        twinSlots.push({
          id: leadTwinSlotId,
          label: `${lead.name} Twin`,
          required: false,
          scope: "teammate",
        })
      }
      const knowledgeTwinIds = team.config.knowledgeTwinIds ?? []
      knowledgeTwinIds.forEach((_id, index) => {
        twinSlots.push({
          id: `team.knowledge.${index + 1}`,
          label: `Team knowledge Twin ${index + 1}`,
          required: false,
          scope: "team",
        })
      })
      const members = teammates
        .filter((teammate) => teammate.id !== lead.id)
        .map((teammate) => {
          const twinId = teammate.config.twinId
          const twinSlotId = twinId ? `teammate.${teammate.id}.twin` : undefined
          if (twinSlotId) {
            twinSlots.push({
              id: twinSlotId,
              label: `${teammate.name} Twin`,
              required: false,
              scope: "teammate",
            })
          }
          return {
            localId: teammate.id,
            name: teammate.name,
            description: teammate.description,
            role: teammate.role,
            specialization: teammate.config.specialization,
            config: asObject(teammate.config),
            ...(teammate.spawnPrompt ? { spawnPrompt: teammate.spawnPrompt } : {}),
            ...((teammate as AgentTeammate & { capabilities?: unknown }).capabilities
              ? {
                  capabilities: stripNonPortable(
                    (teammate as AgentTeammate & { capabilities?: unknown }).capabilities
                  ),
                }
              : {}),
            ...(twinSlotId ? { twinSlotId } : {}),
          }
        })
      const payload: AgentTeamTemplatePayload = {
        team: {
          name: team.name,
          description: team.description,
          task: team.task,
          config: asObject(team.config),
        },
        lead: {
          localId: lead.id,
          name: lead.name,
          description: lead.description,
          config: asObject(lead.config),
          ...(leadTwinSlotId ? { twinSlotId: leadTwinSlotId } : {}),
        },
        teammates: members,
        tasks: tasks.map((task) => ({
          localId: task.id,
          title: task.title,
          description: task.description,
          priority: task.priority,
          ...(task.assignedTo ? { assignedToLocalId: task.assignedTo } : {}),
          dependencies: [...task.dependencies],
          tags: [...task.tags],
          ...(task.expectedOutput ? { expectedOutput: task.expectedOutput } : {}),
          ...(task.estimatedDuration !== undefined
            ? { estimatedDuration: task.estimatedDuration }
            : {}),
          order: task.order,
          ...(task.metadata ? { metadata: stripNonPortable(task.metadata) } : {}),
        })),
        twinSlots,
      }
      return payload
    },

    validate(definition) {
      const payload = definitionPayload<AgentTeamTemplatePayload>(definition)
      const issues: TemplateValidationIssue[] = []
      try {
        taskOrder(payload.tasks ?? [])
      } catch (error) {
        issues.push({
          code: "agent-team.task-cycle",
          path: "payload.tasks",
          message: error instanceof Error ? error.message : String(error),
          severity: "error",
        })
      }
      return issues
    },

    async preflight({ definition, bindings }) {
      const base = standardPreflight(definition, bindings, "Create AgentTeam and staged tasks")
      const payload = definitionPayload<AgentTeamTemplatePayload>(definition)
      try {
        taskOrder(payload.tasks)
      } catch (error) {
        base.issues.push({
          code: "agent-team.task-cycle",
          severity: "blocker",
          message: error instanceof Error ? error.message : String(error),
        })
        base.status = "blocked"
      }
      return base
    },

    async instantiate({ definition, plan }) {
      const bindings = bindingsFromPlan(plan)
      const payload = resolvedPayload<AgentTeamTemplatePayload>(
        definition,
        interpolatableBindings(plan.bindings)
      )
      const teamTwinIds = payload.twinSlots
        .filter((slot) => slot.scope === "team")
        .map((slot) => bindings[slot.id])
        .filter((id): id is string => Boolean(id))
      let teamId: string | undefined
      try {
        const team = await port.createTeam({
          name: payload.team.name,
          description: payload.team.description,
          task: payload.team.task,
          leadName: payload.lead.name,
          leadDescription: payload.lead.description,
          config: {
            ...payload.team.config,
            ...(teamTwinIds.length > 0 ? { knowledgeTwinIds: teamTwinIds } : {}),
          },
        })
        teamId = team.id
        if (team.leadId && port.updateTeammate) {
          await port.updateTeammate(team.leadId, {
            config: {
              ...payload.lead.config,
              ...(payload.lead.twinSlotId && bindings[payload.lead.twinSlotId]
                ? { twinId: bindings[payload.lead.twinSlotId] }
                : {}),
            },
          })
        }
        const teammateIds = new Map<string, string>()
        for (const teammate of payload.teammates) {
          const created = await port.addTeammate({
            teamId,
            name: teammate.name,
            description: teammate.description,
            role: teammate.role,
            spawnPrompt: teammate.spawnPrompt,
            config: {
              ...teammate.config,
              ...(teammate.twinSlotId && bindings[teammate.twinSlotId]
                ? { twinId: bindings[teammate.twinSlotId] }
                : {}),
            },
          })
          teammateIds.set(teammate.localId, created.id)
          if (port.updateTeammate && teammate.capabilities) {
            await port.updateTeammate(created.id, { capabilities: teammate.capabilities })
          }
        }
        const taskIds = new Map<string, string>()
        for (const task of taskOrder(payload.tasks)) {
          const created = await port.createTask({
            teamId,
            title: task.title,
            description: task.description,
            priority: task.priority,
            assignedTo: task.assignedToLocalId
              ? teammateIds.get(task.assignedToLocalId)
              : undefined,
            dependencies: task.dependencies
              .map((dependency) => taskIds.get(dependency))
              .filter((id): id is string => Boolean(id)),
            tags: task.tags,
            expectedOutput: task.expectedOutput,
            estimatedDuration: task.estimatedDuration,
            order: task.order,
            metadata: task.metadata,
          })
          taskIds.set(task.localId, created.id)
        }
        return {
          resources: [{ domain: "agentTeam", id: teamId }],
          rollbackToken: { teamId },
        }
      } catch (error) {
        if (teamId) await port.deleteTeam(teamId)
        throw error
      }
    },

    snapshot(resourceIds) {
      return Promise.resolve(port.snapshot(resourceIds))
    },

    diff: genericDiff,

    async update({ instance, next }) {
      if (!port.update) throw new Error("AgentTeam in-place template update is unavailable")
      return port.update(instance.resources, resolvedUpdatePayload(next, instance))
    },

    async rollback(token) {
      if (token && typeof token === "object" && !Array.isArray(token)) {
        const teamId = token.teamId
        if (typeof teamId === "string") await port.deleteTeam(teamId)
      }
    },

    isActive: port.isActive
      ? (resourceIds) => Promise.resolve(port.isActive!(resourceIds))
      : undefined,
  }
}

function disableWorkflowAutomation(value: TemplateJson): TemplateJson {
  if (Array.isArray(value)) return value.map(disableWorkflowAutomation)
  if (!value || typeof value !== "object") return value
  const next = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !NON_PORTABLE_KEYS.has(key) && !isCredentialKey(key))
      .map(([key, nested]) => [key, disableWorkflowAutomation(nested)])
  )
  if (
    typeof next.type === "string" &&
    next.type.startsWith("trigger.") &&
    next.type !== "trigger.manual"
  ) {
    const data =
      next.data && typeof next.data === "object" && !Array.isArray(next.data) ? next.data : {}
    const params =
      data.params && typeof data.params === "object" && !Array.isArray(data.params)
        ? data.params
        : {}
    next.data = { ...data, disabled: true, params: { ...params, enabled: false } }
  }
  return next
}

export function projectPortableWorkflowValue(value: unknown): TemplateJson {
  return disableWorkflowAutomation(toJson(value))
}

export function createWorkflowTemplateAdapter(port: CrudTemplatePort): TemplateDomainAdapter {
  const adapter = createCrudTemplateAdapter("workflow", port, "Create disabled workflow draft")
  return {
    ...adapter,
    async project(resource) {
      return disableWorkflowAutomation(toJson(resource))
    },
  }
}

function createCrudTemplateAdapter(
  domain: Exclude<TemplateDomain, "agentTeam">,
  port: CrudTemplatePort,
  summary: string
): TemplateDomainAdapter {
  return {
    domain,
    async project(resource) {
      const portable = stripNonPortable(resource)
      if (
        domain === "character" &&
        resource &&
        typeof resource === "object" &&
        typeof (resource as { twinId?: unknown }).twinId === "string" &&
        portable &&
        typeof portable === "object" &&
        !Array.isArray(portable)
      ) {
        portable.bindingSlots = [
          {
            id: "character.twin",
            kind: "twinSlot",
            label: "Character Twin",
            required: false,
          },
        ]
      }
      return portable
    },
    validate() {
      return []
    },
    async preflight({ definition, bindings }) {
      return standardPreflight(definition, bindings, summary)
    },
    async instantiate({ definition, plan }) {
      const bindings = bindingsFromPlan(plan)
      const created = await port.create(
        resolvedPayload(definition, interpolatableBindings(plan.bindings)),
        bindings
      )
      return { resources: [{ domain, id: created.id }], rollbackToken: null }
    },
    snapshot(resourceIds) {
      return Promise.resolve(port.snapshot(resourceIds))
    },
    diff: genericDiff,
    async update({ instance, next }) {
      if (!port.update) throw new Error(`${domain} in-place template update is unavailable`)
      const updated = await port.update(
        instance.resources,
        resolvedUpdatePayload(next, instance),
        {}
      )
      return { resources: [{ domain, id: updated.id }] }
    },
    isActive: port.isActive
      ? (resourceIds) => Promise.resolve(port.isActive!(resourceIds))
      : undefined,
  }
}

export interface FullDomainTemplatePorts {
  agentTeam: AgentTeamTemplatePort
  workflow: CrudTemplatePort
  subagent: CrudTemplatePort
  customMode: CrudTemplatePort
  character: CrudTemplatePort
  skill: CrudTemplatePort
}

export function createFullDomainAdapters(ports: FullDomainTemplatePorts): TemplateDomainAdapter[] {
  return [
    createAgentTeamTemplateAdapter(ports.agentTeam),
    createWorkflowTemplateAdapter(ports.workflow),
    createCrudTemplateAdapter("subagent", ports.subagent, "Create Subagent template"),
    createCrudTemplateAdapter("customMode", ports.customMode, "Create Custom Mode"),
    createCrudTemplateAdapter("character", ports.character, "Create Character"),
    createCrudTemplateAdapter("skill", ports.skill, "Create Skill"),
  ]
}
