import { appTemplates } from "@/lib/a2ui/templates"
import { listGoalTemplates } from "@/lib/db/goal-templates"
import { listPresets } from "@/lib/db/prompt-presets"
import { getDb } from "@/lib/db/schema"
import { TASK_TEMPLATES } from "@/lib/scheduler/task-templates"
import {
  buildPresetTemplates,
  type PresetTemplateProvider,
} from "@/types/subscription/preset-templates"
import { projectPortableTemplateValue } from "./adapters"
import { TemplateCatalog } from "./catalog"
import {
  createTemplateDefinition,
  type TemplateDefinitionEnvelope,
  type TemplateDomain,
  type TemplateJson,
  type TemplateTrust,
} from "./contracts"

interface CatalogOnlyRecord {
  id: string
  name: string
  description?: string
  category?: string
  tags?: string[]
  payload: TemplateJson
  trust: TemplateTrust
}

export interface CatalogOnlyReaders {
  a2ui(): Promise<readonly CatalogOnlyRecord[]>
  goal(): Promise<readonly CatalogOnlyRecord[]>
  scheduler(): Promise<readonly CatalogOnlyRecord[]>
  prompt(): Promise<readonly CatalogOnlyRecord[]>
  subscription(): Promise<readonly CatalogOnlyRecord[]>
  document(): Promise<readonly CatalogOnlyRecord[]>
}

function row(
  value: Record<string, unknown>,
  input: {
    id: string
    name: string
    trust?: TemplateTrust
    payload?: unknown
  }
): CatalogOnlyRecord {
  return {
    id: input.id,
    name: input.name,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.category === "string" ? { category: value.category } : {}),
    ...(Array.isArray(value.tags)
      ? { tags: value.tags.filter((tag): tag is string => typeof tag === "string") }
      : {}),
    payload: projectPortableTemplateValue(input.payload ?? value),
    trust: input.trust ?? "unsigned",
  }
}

function defaultReaders(): CatalogOnlyReaders {
  return {
    a2ui: async () => {
      const user = await getDb().a2uiTemplates.toArray()
      return [
        ...appTemplates.map((template) =>
          row(template as unknown as Record<string, unknown>, {
            id: template.id,
            name: template.name,
            trust: "built-in",
          })
        ),
        ...user.map((template) =>
          row(template as unknown as Record<string, unknown>, {
            id: template.id,
            name: template.name,
          })
        ),
      ]
    },
    goal: async () =>
      (await listGoalTemplates()).map((template) =>
        row(template as unknown as Record<string, unknown>, {
          id: template.id,
          name: template.title,
          trust: template.builtin ? "built-in" : "unsigned",
        })
      ),
    scheduler: async () =>
      TASK_TEMPLATES.map((template) =>
        row(template as unknown as Record<string, unknown>, {
          id: template.id,
          name: template.name,
          trust: "built-in",
          payload: template.getInput(),
        })
      ),
    prompt: async () =>
      (await listPresets()).map((preset) =>
        row(preset as unknown as Record<string, unknown>, {
          id: preset.id,
          name: preset.name,
          trust: preset.isBuiltIn ? "built-in" : "unsigned",
        })
      ),
    subscription: async () =>
      (["anthropic", "codex", "opencode"] as PresetTemplateProvider[]).flatMap((provider) =>
        buildPresetTemplates(provider).map((template) =>
          row(template as unknown as Record<string, unknown>, {
            id: `${provider}.${template.templateId}`,
            name: template.label,
            trust: "built-in",
          })
        )
      ),
    document: async () => [],
  }
}

async function definitionsFor(
  domain: TemplateDomain,
  records: readonly CatalogOnlyRecord[]
): Promise<TemplateDefinitionEnvelope[]> {
  return Promise.all(
    records.map((record) =>
      createTemplateDefinition({
        id: `catalog.${domain}.${record.id}`,
        domain,
        status: "published",
        revision: 1,
        version: "1.0.0",
        metadata: {
          name: record.name,
          description: record.description,
          category: record.category,
          tags: record.tags,
        },
        payload: record.payload,
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["desktop", "web", "mobile"] },
        provenance: {
          source: record.trust === "built-in" ? "built-in" : "user",
          trust: record.trust,
        },
      })
    )
  )
}

export async function refreshCatalogOnlyTemplateAdapters(
  catalog: TemplateCatalog,
  overrides: Partial<CatalogOnlyReaders> = {}
): Promise<number> {
  const readers = { ...defaultReaders(), ...overrides }
  const domains = ["a2ui", "goal", "scheduler", "prompt", "subscription", "document"] as const
  let count = 0
  for (const domain of domains) {
    const definitions = await definitionsFor(domain, await readers[domain]())
    catalog.replaceSource(`legacy-catalog:${domain}`, definitions)
    count += definitions.length
  }
  return count
}
