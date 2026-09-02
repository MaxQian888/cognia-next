/**
 * The executor's cache writes (ADR-0163, Batch 13): the model listing of
 * one deployment × account, and the operation cells computed for it. Both
 * are rebuildable Dexie rows, so a write that fails (no IndexedDB on a
 * headless host, a locked vault, a closed database) must never fail the
 * operation that produced the data. Every call here is best-effort and the
 * last failure is kept for diagnostics.
 *
 * The Dexie module is loaded lazily so callers that only need the registry
 * or the types do not pull the database graph into their bundle.
 */

import type {
  ProviderConnectionInventoryRow,
  putOperationSnapshots,
} from "@/lib/db/provider-catalog"

export type OperationSnapshotWrite = Parameters<typeof putOperationSnapshots>[0]

export interface ProviderOperationPersistence {
  readInventory(deploymentRef: string): Promise<ProviderConnectionInventoryRow | undefined>
  writeInventory(row: ProviderConnectionInventoryRow): Promise<void>
  writeSnapshots(input: OperationSnapshotWrite): Promise<void>
  /** The most recent swallowed failure, for diagnostics and tests. */
  readonly lastError: unknown
}

type CatalogModule = typeof import("@/lib/db/provider-catalog")

export function createProviderOperationPersistence(
  loadCatalog: () => Promise<CatalogModule> = () => import("@/lib/db/provider-catalog")
): ProviderOperationPersistence {
  let lastError: unknown
  async function attempt<T>(run: (catalog: CatalogModule) => Promise<T>): Promise<T | undefined> {
    try {
      return await run(await loadCatalog())
    } catch (error) {
      lastError = error
      return undefined
    }
  }
  return {
    readInventory: (deploymentRef) =>
      attempt((catalog) => catalog.getConnectionInventory(deploymentRef)),
    writeInventory: async (row) => {
      await attempt((catalog) => catalog.putConnectionInventory(row))
    },
    writeSnapshots: async (input) => {
      await attempt((catalog) => catalog.putOperationSnapshots(input))
    },
    get lastError() {
      return lastError
    },
  }
}

/** The process-wide persistence the built-in handlers use. */
export const providerOperationPersistence: ProviderOperationPersistence =
  createProviderOperationPersistence()
