/**
 * SchedulerSourceRegistry
 *
 * Holds one `ScheduledItemSource` per `ScheduledItemKind`. Sources register
 * themselves at module init (or are injected for tests). The unified hook
 * + form pickers reach for `getSource(kind)` to dispatch CRUD; the hook
 * walks `listAllSources()` to gather items for the unified list.
 *
 * Lifetime: singleton per process. Tests use `createSchedulerSourceRegistry()`
 * to obtain a fresh instance.
 */

import type { ScheduledItemKind } from "@/types/scheduler/unified"
import type { ScheduledItemSource } from "./types"

export class SchedulerSourceRegistry {
  private readonly sources = new Map<ScheduledItemKind, ScheduledItemSource>()

  register(source: ScheduledItemSource): void {
    this.sources.set(source.kind, source)
  }

  unregister(kind: ScheduledItemKind): void {
    this.sources.delete(kind)
  }

  getSource(kind: ScheduledItemKind): ScheduledItemSource | undefined {
    return this.sources.get(kind)
  }

  /**
   * All registered sources in registration order. Callers should not rely on
   * a particular order for correctness — the unified hook re-sorts items
   * via `compareUnifiedItems`.
   */
  listAllSources(): ReadonlyArray<ScheduledItemSource> {
    return Array.from(this.sources.values())
  }

  has(kind: ScheduledItemKind): boolean {
    return this.sources.has(kind)
  }

  clear(): void {
    this.sources.clear()
  }
}

export function createSchedulerSourceRegistry(): SchedulerSourceRegistry {
  return new SchedulerSourceRegistry()
}

let singletonRegistry: SchedulerSourceRegistry | null = null

/**
 * Process-wide registry. Created lazily on first access so test files that
 * import a source module before any real adapter is registered don't get a
 * weird leftover state from a previous test.
 */
export function getSchedulerSourceRegistry(): SchedulerSourceRegistry {
  if (!singletonRegistry) {
    singletonRegistry = createSchedulerSourceRegistry()
  }
  return singletonRegistry
}

/** Test-only: reset the singleton between tests. */
export function resetSchedulerSourceRegistry(): void {
  singletonRegistry = null
}
