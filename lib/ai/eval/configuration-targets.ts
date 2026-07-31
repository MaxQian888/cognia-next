import type { AppSettings, Character } from "@cognia/agent-config-types"
import type { WorkflowPatch } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"
import type { EvalConfigurationApplyRow } from "@/lib/db/eval-lab"
import type {
  EvalConfigurationApplicationDeps,
  EvalConfigurationTarget,
} from "./recommendation-application"
import { getDb } from "@/lib/db/schema"

interface ConfigurationTargetDependencies {
  getSettings(): Promise<AppSettings>
  saveSettings(patch: Partial<Omit<AppSettings, "id">>): Promise<AppSettings>
  getCharacter(id: string): Promise<Character | undefined>
  updateCharacter(
    id: string,
    patch: Partial<Omit<Character, "id" | "createdAt" | "isBuiltIn">>
  ): Promise<void>
  getWorkflow(id: string): Promise<WorkflowRow | undefined>
  updateWorkflow(id: string, patch: WorkflowPatch): Promise<WorkflowRow | undefined>
  saveRecord(record: EvalConfigurationApplyRow): Promise<void>
  getRecord(id: string): Promise<EvalConfigurationApplyRow | undefined>
  updateRecord(id: string, patch: Partial<EvalConfigurationApplyRow>): Promise<void>
  now(): number
  newId(): string
}

const CHARACTER_KEYS = [
  "model",
  "systemPrompt",
  "permissionMode",
  "allowedTools",
  "disallowedTools",
  "mcpServerIds",
  "skillIds",
  "workingDir",
  "bareMode",
  "debugMode",
  "briefMode",
  "twinId",
  "twinSettings",
] as const

const WORKFLOW_KEYS = ["settings", "nodes", "edges", "variables", "staticData"] as const

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => (key in source ? [[key, source[key]]] : [])))
}

async function defaultDependencies(): Promise<ConfigurationTargetDependencies> {
  const [settings, characters, workflows] = await Promise.all([
    import("@/lib/db/settings"),
    import("@/lib/db/characters"),
    import("@/lib/db/workflows"),
  ])
  return {
    getSettings: settings.getSettings,
    saveSettings: settings.saveSettings,
    getCharacter: characters.getCharacter,
    updateCharacter: characters.updateCharacter,
    getWorkflow: workflows.getWorkflow,
    updateWorkflow: workflows.updateWorkflow,
    saveRecord: async (record) => void (await getDb().evalConfigurationApplies.add(record)),
    getRecord: (id) => getDb().evalConfigurationApplies.get(id),
    updateRecord: async (id, patch) =>
      void (await getDb().evalConfigurationApplies.update(id, patch)),
    now: Date.now,
    newId: () => crypto.randomUUID(),
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required for the recommended configuration`)
  }
  return value
}

export function createEvalConfigurationApplicationDeps(
  dependencies: ConfigurationTargetDependencies
): EvalConfigurationApplicationDeps {
  return {
    async read(target: EvalConfigurationTarget) {
      if (target.targetType === "default-model") {
        const settings = await dependencies.getSettings()
        return { providerId: settings.defaultProvider, modelId: settings.defaultModel }
      }
      if (target.targetType === "routing-policy") {
        return { ...((await dependencies.getSettings()).routingConfig ?? {}) }
      }
      if (target.targetType === "character") {
        const character = await dependencies.getCharacter(target.targetId)
        if (!character) throw new Error(`Character ${target.targetId} not found`)
        return pick(character as unknown as Record<string, unknown>, CHARACTER_KEYS)
      }
      const workflow = await dependencies.getWorkflow(target.targetId)
      if (!workflow) throw new Error(`Workflow ${target.targetId} not found`)
      return pick(workflow as unknown as Record<string, unknown>, WORKFLOW_KEYS)
    },
    async write(target: EvalConfigurationTarget, value: Record<string, unknown>) {
      if (target.targetType === "default-model") {
        await dependencies.saveSettings({
          defaultProvider: assertString(value.providerId, "providerId"),
          defaultModel: assertString(value.modelId, "modelId"),
        })
        return
      }
      if (target.targetType === "routing-policy") {
        await dependencies.saveSettings({
          routingConfig: value as unknown as AppSettings["routingConfig"],
        })
        return
      }
      if (target.targetType === "character") {
        await dependencies.updateCharacter(
          target.targetId,
          pick(value, CHARACTER_KEYS) as Partial<Omit<Character, "id" | "createdAt" | "isBuiltIn">>
        )
        return
      }
      await dependencies.updateWorkflow(
        target.targetId,
        pick(value, WORKFLOW_KEYS) as WorkflowPatch
      )
    },
    saveRecord: dependencies.saveRecord,
    getRecord: dependencies.getRecord,
    updateRecord: dependencies.updateRecord,
    now: dependencies.now,
    newId: dependencies.newId,
  }
}

export async function browserEvalConfigurationApplicationDeps(): Promise<EvalConfigurationApplicationDeps> {
  return createEvalConfigurationApplicationDeps(await defaultDependencies())
}
