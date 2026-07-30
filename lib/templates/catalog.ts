import type {
  TemplateDefinitionEnvelope,
  TemplateDomain,
  TemplatePlatform,
  TemplateStatus,
  TemplateTrust,
} from "./contracts"

export interface TemplateCatalogQuery {
  domain?: TemplateDomain
  status?: TemplateStatus
  source?: TemplateDefinitionEnvelope["provenance"]["source"]
  trust?: TemplateTrust
  platform?: TemplatePlatform
  text?: string
}

export interface TemplateCatalogSnapshot {
  revision: number
  definitions: readonly TemplateDefinitionEnvelope[]
}

function catalogKey(definition: TemplateDefinitionEnvelope): string {
  return `${definition.id}@${definition.version ?? `${definition.status}:${definition.revision}`}`
}

function freezeDefinition(definition: TemplateDefinitionEnvelope): TemplateDefinitionEnvelope {
  return Object.freeze(structuredClone(definition))
}

export class TemplateCatalog {
  private readonly sources = new Map<string, Map<string, TemplateDefinitionEnvelope>>()
  private readonly listeners = new Set<() => void>()
  private revision = 0
  private snapshot: TemplateCatalogSnapshot = Object.freeze({
    revision: 0,
    definitions: Object.freeze([]),
  })

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getRevision = (): number => this.revision
  getSnapshot = (): TemplateCatalogSnapshot => this.snapshot
  getServerSnapshot = (): TemplateCatalogSnapshot => this.snapshot

  replaceSource(sourceId: string, definitions: readonly TemplateDefinitionEnvelope[]): void {
    const next = new Map<string, TemplateDefinitionEnvelope>()
    for (const definition of definitions) {
      next.set(catalogKey(definition), freezeDefinition(definition))
    }
    this.sources.set(sourceId, next)
    this.changed()
  }

  register(sourceId: string, definition: TemplateDefinitionEnvelope): () => void {
    const source = this.sources.get(sourceId) ?? new Map<string, TemplateDefinitionEnvelope>()
    const key = catalogKey(definition)
    source.set(key, freezeDefinition(definition))
    this.sources.set(sourceId, source)
    this.changed()
    let active = true
    return () => {
      if (!active) return
      active = false
      const current = this.sources.get(sourceId)
      if (!current?.delete(key)) return
      if (current.size === 0) this.sources.delete(sourceId)
      this.changed()
    }
  }

  upsert(sourceId: string, definition: TemplateDefinitionEnvelope): void {
    const source = this.sources.get(sourceId) ?? new Map<string, TemplateDefinitionEnvelope>()
    if (definition.version === null) {
      for (const [key, candidate] of source) {
        if (
          candidate.id === definition.id &&
          candidate.version === null &&
          candidate.status === definition.status
        ) {
          source.delete(key)
        }
      }
    }
    source.set(catalogKey(definition), freezeDefinition(definition))
    this.sources.set(sourceId, source)
    this.changed()
  }

  removeSource(sourceId: string): boolean {
    const removed = this.sources.delete(sourceId)
    if (removed) this.changed()
    return removed
  }

  get(id: string, version?: string | null): TemplateDefinitionEnvelope | undefined {
    return this.snapshot.definitions.find(
      (definition) =>
        definition.id === id && (version === undefined || definition.version === version)
    )
  }

  query(query: TemplateCatalogQuery = {}): TemplateDefinitionEnvelope[] {
    const text = query.text?.trim().toLocaleLowerCase()
    return this.snapshot.definitions.filter((definition) => {
      if (query.domain && definition.domain !== query.domain) return false
      if (query.status && definition.status !== query.status) return false
      if (query.source && definition.provenance.source !== query.source) return false
      if (query.trust && definition.provenance.trust !== query.trust) return false
      if (query.platform && !definition.compatibility.platforms.includes(query.platform)) {
        return false
      }
      if (text) {
        const haystack = [
          definition.id,
          definition.metadata.name,
          definition.metadata.description,
          definition.metadata.category,
          definition.metadata.author,
          ...(definition.metadata.tags ?? []),
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase()
        if (!haystack.includes(text)) return false
      }
      return true
    })
  }

  private changed(): void {
    this.revision += 1
    const definitions = [...this.sources.values()]
      .flatMap((source) => [...source.values()])
      .sort((left, right) => {
        const byName = left.metadata.name.localeCompare(right.metadata.name)
        if (byName !== 0) return byName
        return catalogKey(left).localeCompare(catalogKey(right))
      })
    this.snapshot = Object.freeze({
      revision: this.revision,
      definitions: Object.freeze(definitions),
    })
    for (const listener of this.listeners) listener()
  }
}

export const templateCatalog = new TemplateCatalog()
