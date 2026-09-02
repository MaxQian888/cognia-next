import {
  parseCatalogSnapshot,
  type CatalogRevision,
  type CatalogContribution,
  type CatalogSnapshot,
  type ModelAlias,
  type ModelDefinition,
  type ProviderDefinition,
  type ProviderOffering,
} from "@cognia/provider-types/model-catalog"
import type {
  ProviderModelCandidate,
  ProviderModelFreshness,
  ProviderModelSource,
  ProviderOperationCell,
  ProviderOperationId,
} from "@cognia/provider-types"
import {
  InMemoryCatalogRepository,
  type CatalogProviderFilter,
  type CatalogRepository,
  type CatalogSearchQuery,
} from "@cognia/provider-core/providers/catalog-repository"

import { getDb } from "./schema"

export interface ProviderCatalogRevisionRow extends CatalogRevision {
  status: "staged" | "active" | "previous"
  providerCount: number
  modelCount: number
  offeringCount: number
  aliasCount: number
}

export type ProviderCatalogProviderRow = ProviderDefinition & { revisionId: string }
export type ProviderCatalogModelRow = ModelDefinition & { revisionId: string }
export type ProviderCatalogOfferingRow = ProviderOffering & { revisionId: string }
export type ProviderCatalogAliasRow = ModelAlias & { revisionId: string }

export interface ProviderCatalogStateRow {
  id: "singleton"
  activeRevisionId?: string
  previousRevisionId?: string
  stagedRevisionIds: string[]
}

/**
 * What one deployment × account can reach right now (ADR-0163). Keyed by
 * deployment AND account: a key rotation or an organisation switch changes
 * what is listed, so rows are never aggregated per provider.
 */
export interface ProviderConnectionInventoryRow {
  id: string
  deploymentRef: string
  providerRef: string
  status: "unknown" | "healthy" | "degraded" | "unavailable"
  checkedAt: number
  availableUpstreamIds: string[]
  normalizedError?: string
  /** Account the listing was taken under (credential affinity, never the key). */
  accountRef?: string
  /** The full listing, when a `models.list` produced one. */
  models?: ProviderModelCandidate[]
  source?: ProviderModelSource
  freshness?: ProviderModelFreshness
  /** After this instant the listing is stale and a caller should re-list. */
  expiresAt?: number
}

/** One operation cell of one deployment × account, as last computed. */
export interface ProviderOperationSnapshotRow {
  id: string
  providerId: string
  deploymentRef: string
  accountRef: string
  operationId: ProviderOperationId
  cell: ProviderOperationCell
  computedAt: number
  expiresAt?: number
}

export function operationSnapshotId(input: {
  deploymentRef: string
  accountRef: string
  operationId: string
}): string {
  return `${input.deploymentRef}#${input.accountRef}#${input.operationId}`
}

const CATALOG_STATE_ID = "singleton" as const

function withRevision<T extends { id: string }>(
  revisionId: string,
  documents: readonly T[]
): Array<T & { revisionId: string }> {
  return documents.map((document) => ({ ...document, revisionId }))
}

function withoutRevision<T extends { revisionId: string }>(document: T): Omit<T, "revisionId"> {
  const { revisionId: _revisionId, ...value } = document
  return value
}

async function deleteRevisionDocuments(revisionId: string): Promise<void> {
  const db = getDb()
  await Promise.all([
    db.providerCatalogProviders.where("revisionId").equals(revisionId).delete(),
    db.providerCatalogModels.where("revisionId").equals(revisionId).delete(),
    db.providerCatalogOfferings.where("revisionId").equals(revisionId).delete(),
    db.providerCatalogAliases.where("revisionId").equals(revisionId).delete(),
    db.providerCatalogRevisions.delete(revisionId),
  ])
}

/** Validate and atomically stage a complete catalog revision. */
export async function stageCatalogRevision(snapshot: CatalogSnapshot): Promise<void> {
  const parsed = parseCatalogSnapshot(snapshot)
  if (!parsed.ok) {
    throw new Error(`catalog revision failed validation: ${parsed.errors.join("; ")}`)
  }
  if (parsed.value.revision.integrity !== "verified") {
    throw new Error("catalog revision integrity must be verified before staging")
  }

  const db = getDb()
  const value = parsed.value
  await db.transaction(
    "rw",
    [
      db.providerCatalogRevisions,
      db.providerCatalogProviders,
      db.providerCatalogModels,
      db.providerCatalogOfferings,
      db.providerCatalogAliases,
      db.providerCatalogState,
    ],
    async () => {
      await deleteRevisionDocuments(value.revision.id)
      await db.providerCatalogProviders.bulkPut(withRevision(value.revision.id, value.providers))
      await db.providerCatalogModels.bulkPut(withRevision(value.revision.id, value.models))
      await db.providerCatalogOfferings.bulkPut(withRevision(value.revision.id, value.offerings))
      await db.providerCatalogAliases.bulkPut(withRevision(value.revision.id, value.aliases))
      await db.providerCatalogRevisions.put({
        ...value.revision,
        status: "staged",
        providerCount: value.providers.length,
        modelCount: value.models.length,
        offeringCount: value.offerings.length,
        aliasCount: value.aliases.length,
      })
      const state = (await db.providerCatalogState.get(CATALOG_STATE_ID)) ?? {
        id: CATALOG_STATE_ID,
        stagedRevisionIds: [],
      }
      await db.providerCatalogState.put({
        ...state,
        stagedRevisionIds: [...new Set([...state.stagedRevisionIds, value.revision.id])].sort(),
      })
    }
  )
}

/**
 * Atomically switch the active revision and retain only active + previous.
 * A failed validation/staging never reaches this path, preserving LKG.
 */
export async function activateCatalogRevision(revisionId: string): Promise<void> {
  const db = getDb()
  await db.transaction(
    "rw",
    [
      db.providerCatalogRevisions,
      db.providerCatalogProviders,
      db.providerCatalogModels,
      db.providerCatalogOfferings,
      db.providerCatalogAliases,
      db.providerCatalogState,
    ],
    async () => {
      const next = await db.providerCatalogRevisions.get(revisionId)
      if (!next || next.status !== "staged" || next.integrity !== "verified") {
        throw new Error(`catalog revision "${revisionId}" is not verified and staged`)
      }
      const state = (await db.providerCatalogState.get(CATALOG_STATE_ID)) ?? {
        id: CATALOG_STATE_ID,
        stagedRevisionIds: [],
      }
      const previousRevisionId = state.activeRevisionId
      if (previousRevisionId) {
        await db.providerCatalogRevisions.update(previousRevisionId, { status: "previous" })
      }
      await db.providerCatalogRevisions.update(revisionId, { status: "active" })

      const retained = new Set([revisionId, previousRevisionId].filter(Boolean))
      const obsolete = (await db.providerCatalogRevisions.toArray())
        .map((revision) => revision.id)
        .filter((id) => !retained.has(id))
      for (const obsoleteRevisionId of obsolete) {
        await deleteRevisionDocuments(obsoleteRevisionId)
      }

      await db.providerCatalogState.put({
        id: CATALOG_STATE_ID,
        activeRevisionId: revisionId,
        previousRevisionId,
        stagedRevisionIds: [],
      })
    }
  )
}

export function getCatalogState(): Promise<ProviderCatalogStateRow | undefined> {
  return getDb().providerCatalogState.get(CATALOG_STATE_ID)
}

export async function getCatalogSnapshot(revisionId: string): Promise<CatalogSnapshot | undefined> {
  const db = getDb()
  const revision = await db.providerCatalogRevisions.get(revisionId)
  if (!revision) return undefined
  const [providers, models, offerings, aliases] = await Promise.all([
    db.providerCatalogProviders.where("revisionId").equals(revisionId).toArray(),
    db.providerCatalogModels.where("revisionId").equals(revisionId).toArray(),
    db.providerCatalogOfferings.where("revisionId").equals(revisionId).toArray(),
    db.providerCatalogAliases.where("revisionId").equals(revisionId).toArray(),
  ])
  const {
    status: _status,
    providerCount: _providerCount,
    modelCount: _modelCount,
    offeringCount: _offeringCount,
    aliasCount: _aliasCount,
    ...catalogRevision
  } = revision
  return {
    revision: catalogRevision,
    providers: providers.map(withoutRevision),
    models: models.map(withoutRevision),
    offerings: offerings.map(withoutRevision),
    aliases: aliases.map(withoutRevision),
  }
}

export async function getActiveCatalogSnapshot(): Promise<CatalogSnapshot | undefined> {
  const state = await getCatalogState()
  return state?.activeRevisionId ? getCatalogSnapshot(state.activeRevisionId) : undefined
}

export async function putConnectionInventory(row: ProviderConnectionInventoryRow): Promise<void> {
  await getDb().providerConnectionInventory.put(row)
}

export function getConnectionInventory(
  deploymentRef: string
): Promise<ProviderConnectionInventoryRow | undefined> {
  return getDb().providerConnectionInventory.where("deploymentRef").equals(deploymentRef).first()
}

/** Replace the snapshot rows of one deployment × account with `cells`. */
export async function putOperationSnapshots(input: {
  providerId: string
  deploymentRef: string
  accountRef: string
  cells: readonly ProviderOperationCell[]
  computedAt: number
  expiresAt?: number
}): Promise<void> {
  const rows: ProviderOperationSnapshotRow[] = input.cells.map((cell) => ({
    id: operationSnapshotId({
      deploymentRef: input.deploymentRef,
      accountRef: input.accountRef,
      operationId: cell.operationId,
    }),
    providerId: input.providerId,
    deploymentRef: input.deploymentRef,
    accountRef: input.accountRef,
    operationId: cell.operationId,
    cell,
    computedAt: input.computedAt,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
  }))
  const db = getDb()
  await db.transaction("rw", db.providerOperationSnapshots, async () => {
    await db.providerOperationSnapshots
      .where("deploymentRef")
      .equals(input.deploymentRef)
      .and((row) => row.accountRef === input.accountRef)
      .delete()
    await db.providerOperationSnapshots.bulkPut(rows)
  })
}

export function getOperationSnapshot(input: {
  deploymentRef: string
  accountRef: string
  operationId: string
}): Promise<ProviderOperationSnapshotRow | undefined> {
  return getDb().providerOperationSnapshots.get(operationSnapshotId(input))
}

/** Every snapshot of a provider, optionally narrowed to one deployment. */
export function listOperationSnapshots(input: {
  providerId: string
  deploymentRef?: string
}): Promise<ProviderOperationSnapshotRow[]> {
  const db = getDb()
  const query = input.deploymentRef
    ? db.providerOperationSnapshots.where("deploymentRef").equals(input.deploymentRef)
    : db.providerOperationSnapshots.where("providerId").equals(input.providerId)
  return query.and((row) => row.providerId === input.providerId).toArray()
}

/** Browser/Tauri persistence adapter for the shared synchronous read model. */
export class DexieCatalogRepository implements CatalogRepository {
  private readonly memory = new InMemoryCatalogRepository()
  private hydratePromise?: Promise<void>

  hydrate(): Promise<void> {
    this.hydratePromise ??= (async () => {
      const snapshot = await getActiveCatalogSnapshot()
      if (!snapshot) return
      await this.memory.stageRevision(snapshot)
      await this.memory.activateRevision(snapshot.revision.id)
    })()
    return this.hydratePromise
  }

  listProviders(filter?: CatalogProviderFilter) {
    return this.memory.listProviders(filter)
  }

  searchModels(query?: CatalogSearchQuery) {
    return this.memory.searchModels(query)
  }

  getModel(modelId: string) {
    return this.memory.getModel(modelId)
  }

  listOfferings(modelRef?: string) {
    return this.memory.listOfferings(modelRef)
  }

  resolveAlias(aliasId: string) {
    return this.memory.resolveAlias(aliasId)
  }

  resolveOffering(providerId: string, upstreamOrAliasId: string) {
    return this.memory.resolveOffering(providerId, upstreamOrAliasId)
  }

  async stageRevision(snapshot: CatalogSnapshot): Promise<void> {
    await stageCatalogRevision(snapshot)
    await this.memory.stageRevision(snapshot)
  }

  async activateRevision(revisionId: string): Promise<void> {
    await this.hydrate()
    const snapshot = await getCatalogSnapshot(revisionId)
    if (!snapshot) throw new Error(`catalog revision "${revisionId}" is not staged`)
    await this.memory.stageRevision(snapshot)
    await activateCatalogRevision(revisionId)
    await this.memory.activateRevision(revisionId)
  }

  registerContribution(namespace: string, contribution: CatalogContribution): () => void {
    return this.memory.registerContribution(namespace, contribution)
  }
}

export const providerCatalogRepository = new DexieCatalogRepository()
