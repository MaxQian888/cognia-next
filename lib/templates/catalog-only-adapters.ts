import type { ChatTemplateDefinition } from "@/lib/chat/template/template"
import { appTemplates } from "@/lib/a2ui/templates"
import { listChatTemplates, subscribeChatTemplates } from "@/lib/db/chat-templates"
import { listDocumentTemplates, subscribeDocumentTemplates } from "@/lib/db/document-templates"
import {
  BUILTIN_DOCUMENT_TEMPLATE_FORMAT,
  BUILTIN_DOCUMENT_TEMPLATE_IDS,
  BUILTIN_DOCUMENT_TEMPLATE_LOCALES,
  builtinDocumentTemplateCopy,
} from "@/lib/document-templates/builtin"
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
  /** Per-locale names, for records whose copy is localized (built-in documents). */
  localized?: Record<string, { name: string; description?: string }>
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
      (["anthropic", "codex", "opencode", "commandcode"] as PresetTemplateProvider[]).flatMap(
        (provider) =>
          buildPresetTemplates(provider).map((template) =>
            row(template as unknown as Record<string, unknown>, {
              id: `${provider}.${template.templateId}`,
              name: template.label,
              trust: "built-in",
            })
          )
      ),
    /**
     * Document templates (ADR-0223): the built-ins in code, named in every
     * locale they ship in, then the ones people saved from Files or the
     * canvas. Starting a document from one happens in Files, which copies the
     * content into a new canvas document — so, like chat templates, this
     * domain is catalog-only. A saved template's revision moves with its
     * content, and is spent as the catalog version.
     */
    document: async () => [
      ...BUILTIN_DOCUMENT_TEMPLATE_IDS.map((id) => {
        const copy = builtinDocumentTemplateCopy(id, "en")
        return {
          id,
          name: copy.name,
          description: copy.description,
          payload: projectPortableTemplateValue({
            name: copy.name,
            description: copy.description,
            content: copy.content,
            ...BUILTIN_DOCUMENT_TEMPLATE_FORMAT,
          }),
          trust: "built-in" as const,
          localized: Object.fromEntries(
            Object.keys(BUILTIN_DOCUMENT_TEMPLATE_LOCALES).map((locale) => {
              const local = builtinDocumentTemplateCopy(id, locale)
              return [locale, { name: local.name, description: local.description }]
            })
          ),
        }
      }),
      ...(await listDocumentTemplates()).map((template) => ({
        id: template.id,
        name: template.name,
        ...(template.description ? { description: template.description } : {}),
        payload: projectPortableTemplateValue({
          name: template.name,
          ...(template.description ? { description: template.description } : {}),
          content: template.content,
          language: template.language,
          type: template.type,
        }),
        trust: "unsigned" as const,
        version: `${Math.max(1, template.revision)}.0.0`,
      })),
    ],
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
          ...(record.localized ? { localized: record.localized } : {}),
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
 * The live half of the chat-template and document-template projections.
 *
 * Every other catalog-only domain reads a store that is edited somewhere the
 * Studio can see, or does not change at all at runtime. Chat templates are
 * saved from the COMPOSER and document templates from Files and the canvas,
 * one click away from the surfaces that list them, so a projection built once
 * at boot would be wrong the first time anybody used the feature.
 *
 * Installed by `refreshCatalogOnlyTemplateAdapters`, which the template
 * platform initializer already calls at boot, so there is no second thing to
 * remember to wire. Re-installing against the same catalog is a no-op, and
 * against a different one (a test, or a runtime rebuilt after a reset) it drops
 * the old subscriptions first so a discarded catalog is not kept alive by them.
 */
type LiveDomain = "chatTemplate" | "document"

const LIVE_DOMAIN_SUBSCRIBERS: Record<LiveDomain, (listener: () => void) => () => void> = {
  chatTemplate: subscribeChatTemplates,
  document: subscribeDocumentTemplates,
}

let watchedCatalog: TemplateCatalog | null = null
let unwatchLiveDomains: Array<() => void> = []

function watchLiveDomains(catalog: TemplateCatalog, readers: CatalogOnlyReaders) {
  if (watchedCatalog === catalog) return
  stopCatalogOnlyTemplateWatches()
  watchedCatalog = catalog
  unwatchLiveDomains = (Object.keys(LIVE_DOMAIN_SUBSCRIBERS) as LiveDomain[]).map((domain) =>
    LIVE_DOMAIN_SUBSCRIBERS[domain](() => {
      void readers[domain]()
        .then((records) => definitionsFor(domain, records))
        .then((definitions) => catalog.replaceSource(`legacy-catalog:${domain}`, definitions))
        // A projection that failed to rebuild leaves the previous one standing,
        // which is stale but readable. Throwing here would surface as an
        // unhandled rejection from inside somebody's save.
        .catch(() => undefined)
    })
  )
}

/** Drop the live-domain subscriptions. Exists so tests do not leak them. */
export function stopCatalogOnlyTemplateWatches(): void {
  for (const unwatch of unwatchLiveDomains) unwatch()
  unwatchLiveDomains = []
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
  watchLiveDomains(catalog, readers)
  return count
}
