export type ResyncResolver = () => Promise<void>

function eventDomain(event: string): string {
  const scheme = event.indexOf("://")
  if (scheme > 0) return event.slice(0, scheme)
  const colon = event.indexOf(":")
  return colon > 0 ? event.slice(0, colon) : event
}

/**
 * Maps remote event domains to authoritative snapshot/read recovery.
 *
 * A wildcard resolver is used by the companion sync bootstrap to refresh all
 * synchronized tables. More specific resolvers can replace it for domains
 * whose authoritative state lives elsewhere.
 */
export class ResyncCoordinator {
  private readonly resolvers = new Map<string, ResyncResolver>()

  register(domain: string, resolver: ResyncResolver): () => void {
    if (!domain.trim()) throw new Error("ResyncCoordinator: domain is required")
    if (this.resolvers.has(domain)) {
      throw new Error(`ResyncCoordinator: resolver already registered for '${domain}'`)
    }
    this.resolvers.set(domain, resolver)
    return () => {
      if (this.resolvers.get(domain) === resolver) this.resolvers.delete(domain)
    }
  }

  hasResolverForEvent(event: string): boolean {
    return this.resolvers.has(eventDomain(event)) || this.resolvers.has("*")
  }

  async resolve(domains: readonly string[]): Promise<void> {
    const requested = domains.length ? [...new Set(domains)] : ["*"]
    const selected = new Set<ResyncResolver>()
    for (const domain of requested) {
      const resolver = this.resolvers.get(domain) ?? this.resolvers.get("*")
      if (!resolver) {
        throw new Error(`ResyncCoordinator: no authoritative resolver for '${domain}'`)
      }
      selected.add(resolver)
    }
    await Promise.all([...selected].map((resolver) => resolver()))
  }
}

export const remoteEventResyncCoordinator = new ResyncCoordinator()
