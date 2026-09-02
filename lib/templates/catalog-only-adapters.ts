import type { ChatTemplateDefinition } from "@/lib/chat/template/template"
import { appTemplates } from "@/lib/a2ui/templates"
import { listChatTemplates, subscribeChatTemplates } from "@/lib/db/chat-templates"
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
  /**
   * Overrides the `1.0.0` every other catalog-only record carries.
   *
   * The catalog is keyed by id AND version, so a domain whose rows carry a real
   * revision has to spend it: two edits to one chat template are two versions of
   * one definition, and pinning them all at 1.0.0 would make each edit
   * indistinguishable from the last inside the catalog.
   */
  version?: string
}

export interface CatalogOnlyReaders {
  a2ui(): Promise<readonly CatalogOnlyRecord[]>
  goal(): Promise<readonly CatalogOnlyRecord[]>
  scheduler(): Promise<readonly CatalogOnlyRecord[]>
  prompt(): Promise<readonly CatalogOnlyRecord[]>
  subscription(): Promise<readonly CatalogOnlyRecord[]>
  document(): Promise<readonly CatalogOnlyRecord[]>
  chatTemplate(): Promise<readonly CatalogOnlyRecord[]>
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
    /**
     * Always empty, on purpose.
     *
     * `document` is a declared catalog-only domain with no store behind it:
     * nothing in the app owns a "document template" the catalog could project.
     * It stays declared because the domain vocabulary is shared with the plugin
     * SDK and removing a member is a breaking change to a published union,
     * and the Studio labels the facet inert rather than offering a filter that
     * silently returns nothing. Pinned by a test so it stays deliberate.
     */
    document: async () => [],
    /**
     * Saved chat templates, projected as the PORTABLE half of the row.
     *
     * `ChatTemplateDefinition` is already the shape with no ids, timestamps or
     * usage counters in it, so the projection is that type and nothing else.
     * `lastParams` in particular must never reach here: it is the last set of
     * answers somebody typed, which is conversation content rather than a
     * template, and it can hold a resource reference that means nothing on
     * another machine.
     */
    chatTemplate: async () =>
      (await listChatTemplates()).map((template) => ({
        id: template.id,
        name: template.name,
        ...(template.description ? { description: template.description } : {}),
        payload: projectPortableTemplateValue({
          name: template.name,
          ...(template.description ? { description: template.description } : {}),
          body: template.body,
          params: template.params,
        } satisfies ChatTemplateDefinition),
        trust: "unsigned" as const,
        version: `${Math.max(1, template.revision)}.0.0`,
      })),
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
        version: record.version ?? "1.0.0",
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

const CATALOG_ONLY_DOMAIN_ORDER = [
  "a2ui",
  "goal",
  "scheduler",
  "prompt",
  "subscription",
  "document",
  "chatTemplate",
] as const

/**
 * The live half of the chat-template projection.
 *
 * Every other catalog-only domain reads a store that is edited somewhere the
 * Studio can see, or does not change at all at runtime. Chat templates are
 * saved from the COMPOSER, one keystroke away from the surface that is supposed
 * to list them, so a projection built once at boot was wrong the first time
 * anybody used the feature it exists to describe.
 *
 * Installed by `refreshCatalogOnlyTemplateAdapters`, which the template
 * platform initializer already calls at boot, so there is no second thing to
 * remember to wire. Re-installing against the same catalog is a no-op, and
 * against a different one (a test, or a runtime rebuilt after a reset) it drops
 * the old subscription first so a discarded catalog is not kept alive by it.
 */
let watchedCatalog: TemplateCatalog | null = null
let unwatchChatTemplates: (() => void) | null = null

function watchChatTemplates(catalog: TemplateCatalog, read: CatalogOnlyReaders["chatTemplate"]) {
  if (watchedCatalog === catalog) return
  unwatchChatTemplates?.()
  watchedCatalog = catalog
  unwatchChatTemplates = subscribeChatTemplates(() => {
    void read()
      .then((records) => definitionsFor("chatTemplate", records))
      .then((definitions) => catalog.replaceSource("legacy-catalog:chatTemplate", definitions))
      // A projection that failed to rebuild leaves the previous one standing,
      // which is stale but readable. Throwing here would surface as an
      // unhandled rejection from inside somebody's save.
      .catch(() => undefined)
  })
}

/** Drop the chat-template subscription. Exists so tests do not leak one. */
export function stopCatalogOnlyTemplateWatches(): void {
  unwatchChatTemplates?.()
  unwatchChatTemplates = null
  watchedCatalog = null
}

export async function refreshCatalogOnlyTemplateAdapters(
  catalog: TemplateCatalog,
  overrides: Partial<CatalogOnlyReaders> = {}
): Promise<number> {
  const readers = { ...defaultReaders(), ...overrides }
  let count = 0
  for (const domain of CATALOG_ONLY_DOMAIN_ORDER) {
    const definitions = await definitionsFor(domain, await readers[domain]())
    catalog.replaceSource(`legacy-catalog:${domain}`, definitions)
    count += definitions.length
  }
  watchChatTemplates(catalog, readers.chatTemplate)
  return count
}
