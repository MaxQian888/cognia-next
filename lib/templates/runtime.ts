import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import type { AddTeammateInput, CreateTaskInput, CreateTeamInput } from "@/types/agent/agent-team"
import type { SubAgentTemplate } from "@/types/agent/sub-agent"
import type { CustomModeConfig } from "@/stores/agent/custom-mode-store"
import {
  createCharacter,
  getCharacter,
  updateCharacter,
  type CharacterDraft,
} from "@/lib/db/characters"
import { createSkill, getSkill, updateSkill, type SkillDraft } from "@/lib/db/skills"
import {
  createWorkflow,
  getWorkflow,
  listWorkflowRuns,
  updateWorkflow,
  type WorkflowDraft,
  type WorkflowPatch,
} from "@/lib/db/workflows"
import {
  DexieTemplateRepository,
  listTemplateMigrationJournal,
  putTemplateMigrationJournal,
} from "@/lib/db/template-platform"
import { isPublisherTrusted } from "@/lib/db/trusted-publishers"
import { createFullDomainAdapters, type FullDomainTemplatePorts } from "./adapters"
import { templateCatalog, type TemplateCatalog } from "./catalog"
import type { TemplateJson } from "./contracts"
import type { TemplateRepository } from "./repository"
import { TemplateService } from "./service"
import { rollbackTemplateMigration } from "./migration"

export interface TemplateRuntime {
  catalog: TemplateCatalog
  repository: TemplateRepository
  service: TemplateService
}

interface CreateTemplateRuntimeOptions {
  repository: TemplateRepository
  catalog?: TemplateCatalog
  ports: FullDomainTemplatePorts
  isPublisherTrusted?: (publicKey: string) => Promise<boolean>
}

function json(value: unknown): TemplateJson {
  return JSON.parse(JSON.stringify(value)) as TemplateJson
}

function firstResourceId(resourceIds: Array<{ id: string }>, domain: string): string {
  const id = resourceIds[0]?.id
  if (!id) throw new Error(`${domain} template instance has no resource`)
  return id
}

export function createTemplateRuntime(options: CreateTemplateRuntimeOptions): TemplateRuntime {
  const catalog = options.catalog ?? templateCatalog
  const repository = options.repository
  const service = new TemplateService({
    repository,
    catalog,
    adapters: createFullDomainAdapters(options.ports),
    rollbackMigration: (domain) =>
      rollbackTemplateMigration({
        domain,
        repository,
        journal: {
          list: listTemplateMigrationJournal,
          put: putTemplateMigrationJournal,
        },
      }),
    isPublisherTrusted: options.isPublisherTrusted,
  })
  return { catalog, repository, service }
}

export function createProductionTemplatePorts(): FullDomainTemplatePorts {
  return {
    agentTeam: {
      createTeam: (input) =>
        useAgentTeamStore.getState().createTeam(input as unknown as CreateTeamInput),
      addTeammate: (input) =>
        useAgentTeamStore.getState().addTeammate(input as unknown as AddTeammateInput),
      createTask: (input) =>
        useAgentTeamStore.getState().createTask(input as unknown as CreateTaskInput),
      deleteTeam: (teamId) => useAgentTeamStore.getState().deleteTeam(teamId),
      updateTeammate: (teammateId, patch) =>
        useAgentTeamStore.getState().updateTeammate(teammateId, patch),
      snapshot: (resourceIds) => {
        const teamId = firstResourceId(resourceIds, "AgentTeam")
        const state = useAgentTeamStore.getState()
        const team = state.getTeam(teamId)
        if (!team) throw new Error(`AgentTeam ${teamId} no longer exists`)
        return json({
          team,
          teammates: state.getTeammates(teamId),
          tasks: state.getTeamTasks(teamId),
        })
      },
      update: (resourceIds, payload) => {
        const teamId = firstResourceId(resourceIds, "AgentTeam")
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("AgentTeam update payload is invalid")
        }
        const team = payload.team
        if (!team || typeof team !== "object" || Array.isArray(team)) {
          throw new Error("AgentTeam update payload has no team")
        }
        useAgentTeamStore.getState().updateTeam(teamId, team)
        return { resources: [{ domain: "agentTeam", id: teamId }] }
      },
      isActive: (resourceIds) => {
        const team = useAgentTeamStore.getState().getTeam(firstResourceId(resourceIds, "AgentTeam"))
        return team?.status === "planning" || team?.status === "executing"
      },
    },
    workflow: {
      create: async (payload) => {
        const workflow = await createWorkflow(payload as unknown as WorkflowDraft)
        return { id: workflow.id }
      },
      snapshot: async (resourceIds) => {
        const workflow = await getWorkflow(firstResourceId(resourceIds, "Workflow"))
        if (!workflow) throw new Error("Workflow no longer exists")
        return json(workflow)
      },
      update: async (resourceIds, payload) => {
        const id = firstResourceId(resourceIds, "Workflow")
        const workflow = await updateWorkflow(id, payload as unknown as WorkflowPatch)
        if (!workflow) throw new Error(`Workflow ${id} no longer exists`)
        return { id }
      },
      isActive: async (resourceIds) => {
        const runs = await listWorkflowRuns({
          workflowId: firstResourceId(resourceIds, "Workflow"),
          limit: 20,
        })
        return runs.some((run) => ["pending", "running", "paused"].includes(run.status))
      },
    },
    subagent: {
      create: (payload) => {
        const template = {
          ...(payload as unknown as Omit<SubAgentTemplate, "id" | "isBuiltIn">),
          id: crypto.randomUUID(),
          isBuiltIn: false,
        }
        useSubagentRuntimeStore.getState().addTemplate(template)
        return { id: template.id }
      },
      snapshot: (resourceIds) => {
        const id = firstResourceId(resourceIds, "Subagent")
        const template = useSubagentRuntimeStore.getState().templates[id]
        if (!template) throw new Error(`Subagent template ${id} no longer exists`)
        return json(template)
      },
      update: (resourceIds, payload) => {
        const id = firstResourceId(resourceIds, "Subagent")
        useSubagentRuntimeStore
          .getState()
          .updateTemplate(id, payload as unknown as Partial<SubAgentTemplate>)
        return { id }
      },
    },
    customMode: {
      create: (payload) => {
        const mode = useCustomModeStore
          .getState()
          .createMode(payload as unknown as Partial<CustomModeConfig>)
        return { id: mode.id }
      },
      snapshot: (resourceIds) => {
        const id = firstResourceId(resourceIds, "Custom Mode")
        const mode = useCustomModeStore.getState().getMode(id)
        if (!mode) throw new Error(`Custom Mode ${id} no longer exists`)
        return json(mode)
      },
      update: (resourceIds, payload) => {
        const id = firstResourceId(resourceIds, "Custom Mode")
        useCustomModeStore
          .getState()
          .updateMode(id, payload as unknown as Partial<CustomModeConfig>)
        return { id }
      },
    },
    character: {
      create: async (payload, bindings) => {
        const draft = payload as unknown as CharacterDraft
        const character = await createCharacter({
          ...draft,
          ...(bindings["character.twin"] ? { twinId: bindings["character.twin"] } : {}),
        })
        return { id: character.id }
      },
      snapshot: async (resourceIds) => {
        const character = await getCharacter(firstResourceId(resourceIds, "Character"))
        if (!character) throw new Error("Character no longer exists")
        return json(character)
      },
      update: async (resourceIds, payload, bindings) => {
        const id = firstResourceId(resourceIds, "Character")
        await updateCharacter(id, {
          ...(payload as unknown as Partial<CharacterDraft>),
          ...(bindings["character.twin"] ? { twinId: bindings["character.twin"] } : {}),
        })
        return { id }
      },
    },
    skill: {
      create: async (payload) => {
        const skill = await createSkill(payload as unknown as SkillDraft)
        return { id: skill.id }
      },
      snapshot: async (resourceIds) => {
        const skill = await getSkill(firstResourceId(resourceIds, "Skill"))
        if (!skill) throw new Error("Skill no longer exists")
        return json(skill)
      },
      update: async (resourceIds, payload) => {
        const id = firstResourceId(resourceIds, "Skill")
        await updateSkill(id, payload as unknown as Partial<SkillDraft>)
        return { id }
      },
    },
  }
}

let productionRuntime: TemplateRuntime | undefined

export function getTemplateRuntime(): TemplateRuntime {
  productionRuntime ??= createTemplateRuntime({
    repository: new DexieTemplateRepository(),
    catalog: templateCatalog,
    ports: createProductionTemplatePorts(),
    isPublisherTrusted,
  })
  return productionRuntime
}

export function resetTemplateRuntimeForTesting(): void {
  productionRuntime = undefined
}
