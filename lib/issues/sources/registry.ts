/**
 * IssueSourceRegistry
 *
 * Holds one `IssueSourceAdapter` per `IssueSourceKind`. The local source
 * registers itself at module init; GitHub (slice ②) and the agent sources
 * (slice ③) register from their own runtime installers, so a build that omits
 * them still renders a working local-only board.
 *
 * Deliberately mirrors `lib/scheduler/sources/registry.ts` — that registry
 * already solved "six independent backends, one page" and the two should be
 * recognisably the same shape.
 *
 * Lifetime: singleton per process. Tests use `createIssueSourceRegistry()` for
 * a fresh instance, or `resetIssueSourceRegistry()` between cases.
 */

import type {
  IssueSourceAdapter,
  IssueSourceKind,
  IssueSourceQuery,
  UnifiedIssueItem,
} from "@/types/issues/unified"
import { compareUnifiedIssues } from "@/types/issues/unified"

export class IssueSourceRegistry {
  private readonly sources = new Map<IssueSourceKind, IssueSourceAdapter>()

  register(source: IssueSourceAdapter): void {
    this.sources.set(source.kind, source)
  }

  unregister(kind: IssueSourceKind): void {
    this.sources.delete(kind)
  }

  getSource(kind: IssueSourceKind): IssueSourceAdapter | undefined {
    return this.sources.get(kind)
  }

  /**
   * All registered sources in registration order. Callers must not rely on the
   * order for correctness — `listAll` re-sorts via `compareUnifiedIssues`.
   */
  listAllSources(): ReadonlyArray<IssueSourceAdapter> {
    return Array.from(this.sources.values())
  }

  has(kind: IssueSourceKind): boolean {
    return this.sources.has(kind)
  }

  clear(): void {
    this.sources.clear()
  }

  /**
   * Fan out to every registered source and merge the results.
   *
   * A source that throws is skipped rather than failing the whole board — a
   * broken GitHub token must not blank out the user's local issues. Failures
   * come back in `errors` so the toolbar can show a degraded-source badge
   * instead of silently under-reporting.
   */
  async listAll(query: IssueSourceQuery): Promise<{
    items: UnifiedIssueItem[]
    errors: Array<{ kind: IssueSourceKind; error: unknown }>
  }> {
    const sources = this.listAllSources()
    const settled = await Promise.all(
      sources.map(async (source) => {
        try {
          return { kind: source.kind, items: await source.list(query) }
        } catch (error) {
          return { kind: source.kind, error }
        }
      })
    )

    const items: UnifiedIssueItem[] = []
    const errors: Array<{ kind: IssueSourceKind; error: unknown }> = []
    for (const result of settled) {
      if ("error" in result) {
        errors.push({ kind: result.kind, error: result.error })
        continue
      }
      items.push(...result.items)
    }

    return { items: items.sort(compareUnifiedIssues), errors }
  }
}

export function createIssueSourceRegistry(): IssueSourceRegistry {
  return new IssueSourceRegistry()
}

let singletonRegistry: IssueSourceRegistry | null = null

/**
 * Process-wide registry. Created lazily on first access so test files that
 * import a source module before any adapter registers don't inherit leftover
 * state from a previous test.
 */
export function getIssueSourceRegistry(): IssueSourceRegistry {
  if (!singletonRegistry) {
    singletonRegistry = createIssueSourceRegistry()
  }
  return singletonRegistry
}

/** Test-only: reset the singleton between tests. */
export function resetIssueSourceRegistry(): void {
  singletonRegistry = null
}
