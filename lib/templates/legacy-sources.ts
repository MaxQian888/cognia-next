import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"
import { listCharacters } from "@/lib/db/characters"
import { listSkills } from "@/lib/db/skills"
import { listTemplateWorkflows } from "@/lib/db/workflows"
import {
  createFullDomainAdapters,
  projectPortableTemplateValue,
  type AgentTeamTemplatePayload,
  type FullDomainTemplatePorts,
} from "./adapters"
import type { TemplateInputSpec, TemplateJson, TemplatePlatform } from "./contracts"
import type { LegacyTemplateSource } from "./migration"

export interface LegacyTemplateReaders {
  agentTeams(): Promise<readonly AgentTeamTemplate[]> | readonly AgentTeamTemplate[]
  subagents(): Promise<readonly unknown[]> | readonly unknown[]
  customModes(): Promise<readonly unknown[]> | readonly unknown[]
  workflows(): Promise<readonly unknown[]> | readonly unknown[]
  characters(): Promise<readonly unknown[]> | readonly unknown[]
  skills(): Promise<readonly unknown[]> | readonly unknown[]
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function idOf(value: unknown): string {
  const id = record(value).id
  if (typeof id !== "string" || !id.trim()) throw new Error("Legacy template has no stable id")
  return id
}

function nameOf(value: unknown): string {
  const name = record(value).name
  if (typeof name !== "string" || !name.trim()) throw new Error("Legacy template has no name")
  return name
}

function platformsOf(value: unknown): TemplatePlatform[] {
  const platforms = record(value).availableOnPlatforms
  if (!Array.isArray(platforms)) return ["desktop", "web", "mobile"]
  return platforms.filter(
    (platform): platform is TemplatePlatform =>
      platform === "desktop" || platform === "web" || platform === "mobile"
  )
}

function common(
  value: unknown,
  domain: string,
  payload: TemplateJson,
  inputs: TemplateInputSpec[] = []
) {
  const row = record(value)
  const tags = Array.isArray(row.tags)
    ? row.tags.filter((tag): tag is string => typeof tag === "string")
    : []
  return {
    id: `legacy.${domain}.${idOf(value)}`,
    metadata: {
      name: nameOf(value),
      ...(typeof row.description === "string" ? { description: row.description } : {}),
      ...(typeof row.category === "string" ? { category: row.category } : {}),
      tags,
    },
    payload,
    inputs,
    dependencies: [],
    capabilities: [],
    compatibility: { platforms: platformsOf(value) },
  }
}

export function projectLegacyAgentTeam(template: AgentTeamTemplate) {
  const config = record(projectPortableTemplateValue(template.config ?? {}))
  const originalConfig = template.config ?? {}
  const twinSlots: AgentTeamTemplatePayload["twinSlots"] = []
  const inputs: TemplateInputSpec[] = []
  for (const [index] of (originalConfig.knowledgeTwinIds ?? []).entries()) {
    const id = `team.knowledge.${index + 1}`
    twinSlots.push({
      id,
      label: `Team knowledge Twin ${index + 1}`,
      required: false,
      scope: "team",
    })
    inputs.push({
      id,
      kind: "twinSlot",
      label: `Team knowledge Twin ${index + 1}`,
      required: false,
    })
  }
  const teammates = template.teammates.map((teammate, index) => {
    const localId = `teammate-${index + 1}`
    const twinSlotId = teammate.config?.twinId ? `${localId}.twin` : undefined
    if (twinSlotId) {
      twinSlots.push({
        id: twinSlotId,
        label: `${teammate.name} Twin`,
        required: false,
        scope: "teammate",
      })
      inputs.push({
        id: twinSlotId,
        kind: "twinSlot",
        label: `${teammate.name} Twin`,
        required: false,
      })
    }
    return {
      localId,
      name: teammate.name,
      description: teammate.description,
      specialization: teammate.specialization,
      config: record(projectPortableTemplateValue(teammate.config ?? {})) as Record<
        string,
        TemplateJson
      >,
      ...(teammate.systemPrompt ? { spawnPrompt: teammate.systemPrompt } : {}),
      ...(teammate.capabilities
        ? { capabilities: projectPortableTemplateValue(teammate.capabilities) }
        : {}),
      ...(teammate.governanceHints
        ? { governanceHints: projectPortableTemplateValue(teammate.governanceHints) }
        : {}),
      ...(teammate.tags ? { tags: teammate.tags } : {}),
      ...(teammate.iconKey ? { iconKey: teammate.iconKey } : {}),
      ...(twinSlotId ? { twinSlotId } : {}),
    }
  })
  const payload: AgentTeamTemplatePayload = {
    team: {
      name: template.name,
      description: template.description,
      task: "",
      config: config as Record<string, TemplateJson>,
    },
    lead: {
      localId: "lead",
      name: "Team Lead",
      description: "",
      config: {},
    },
    teammates,
    tasks: (template.taskTemplates ?? []).map((task, index) => ({
      localId: `task-${index + 1}`,
      title: task.title,
      description: task.description,
      priority: task.priority,
      ...(task.assignedToIndex !== undefined
        ? { assignedToLocalId: `teammate-${task.assignedToIndex + 1}` }
        : {}),
      dependencies: [],
      tags: [],
      order: index,
    })),
    twinSlots,
  }
  return {
    ...common(template, "agent-team", payload, inputs),
    domain: "agentTeam" as const,
  }
}

export function createLegacyTemplateSources(input: {
  ports: FullDomainTemplatePorts
  readers?: Partial<LegacyTemplateReaders>
}): LegacyTemplateSource[] {
  const adapters = new Map(
    createFullDomainAdapters(input.ports).map((adapter) => [adapter.domain, adapter])
  )
  const readers: LegacyTemplateReaders = {
    agentTeams: () =>
      Object.values(useAgentTeamStore.getState().templates).filter(
        (template) => !template.isBuiltIn
      ),
    subagents: () =>
      Object.values(useSubagentRuntimeStore.getState().templates).filter(
        (template) => !template.isBuiltIn
      ),
    customModes: () =>
      Object.values(useCustomModeStore.getState().customModes).filter((mode) => !mode.isBuiltIn),
    workflows: async () =>
      (await listTemplateWorkflows()).filter((workflow) => !workflow.isBuiltIn),
    characters: async () =>
      (await listCharacters()).filter(
        (character) => !character.isBuiltIn && !character.id.startsWith("cognia-pack:")
      ),
    skills: async () => (await listSkills()).filter((skill) => !skill.isBuiltIn),
    ...input.readers,
  }

  const adapted = (
    domain: "subagent" | "customMode" | "workflow" | "character" | "skill",
    read: () => Promise<readonly unknown[]> | readonly unknown[]
  ): LegacyTemplateSource => ({
    domain,
    read: async () => read(),
    sourceKey: idOf,
    convert: async (row) => {
      const adapter = adapters.get(domain)
      if (!adapter) throw new Error(`Missing ${domain} template adapter`)
      const payload = await adapter.project(row)
      const inputs: TemplateInputSpec[] =
        domain === "character" && typeof record(row).twinId === "string"
          ? [
              {
                id: "character.twin",
                kind: "twinSlot",
                label: "Character Twin",
                required: false,
              },
            ]
          : []
      return {
        ...common(row, domain, payload, inputs),
        domain,
      }
    },
  })

  return [
    {
      domain: "agentTeam",
      read: async () => readers.agentTeams(),
      sourceKey: (row) => idOf(row),
      convert: (row) => projectLegacyAgentTeam(row as AgentTeamTemplate),
    },
    adapted("subagent", readers.subagents),
    adapted("customMode", readers.customModes),
    adapted("workflow", readers.workflows),
    adapted("character", readers.characters),
    adapted("skill", readers.skills),
  ]
}
