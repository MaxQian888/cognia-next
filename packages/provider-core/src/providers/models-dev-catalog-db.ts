import type {
  ModelsDevApi,
  NormalizedModelsDevCatalog,
  NormalizedModelsDevProvider,
} from "./models-dev"

export interface ModelsDevCatalogRow {
  id: string
  fetchedAt: number
  source: "remote" | "bundled"
  providers: Record<string, NormalizedModelsDevProvider>
}

/**
 * Persistence seam for the models.dev catalog. provider-core must not import the
 * app's Dexie layer directly, so catalog reads/writes go through this injected
 * interface. The host wires a Dexie-backed implementation at boot (see the
 * `lib/ai/providers/models-dev-sync.ts` shim). Type imports above are erased at
 * runtime — only the shape crosses the boundary.
 */
export interface ModelsDevCatalogDb {
  getModelsDevCatalog(): Promise<ModelsDevCatalogRow | undefined>
  saveModelsDevCatalog(input: {
    providers: NormalizedModelsDevCatalog
    fetchedAt: number
    source: ModelsDevCatalogRow["source"]
  }): Promise<ModelsDevCatalogRow>
  isModelsDevCatalogStale(maxAgeMs?: number, now?: number): Promise<boolean>
}

export type ModelsDevSnapshotLoader = () => Promise<ModelsDevApi>

/** Catalog staleness window — 7 days. Mirrors the host constant. */
export const MODELS_DEV_STALE_MS = 7 * 24 * 60 * 60 * 1000

let _db: ModelsDevCatalogDb | null = null
let _snapshotLoader: ModelsDevSnapshotLoader | null = null

/** Wire the host's Dexie-backed catalog store. Called once at app boot. */
export function setModelsDevCatalogDb(db: ModelsDevCatalogDb): void {
  _db = db
}

export function setModelsDevSnapshotLoader(loader: ModelsDevSnapshotLoader): void {
  _snapshotLoader = loader
}

function requireDb(): ModelsDevCatalogDb {
  if (!_db) {
    throw new Error(
      "[provider-core] ModelsDevCatalogDb not wired — call setModelsDevCatalogDb() at boot " +
        "(the lib/ai/providers/models-dev-sync shim does this)."
    )
  }
  return _db
}

export function getModelsDevCatalog(): Promise<ModelsDevCatalogRow | undefined> {
  return requireDb().getModelsDevCatalog()
}

export function saveModelsDevCatalog(
  input: Parameters<ModelsDevCatalogDb["saveModelsDevCatalog"]>[0]
): Promise<ModelsDevCatalogRow> {
  return requireDb().saveModelsDevCatalog(input)
}

export function isModelsDevCatalogStale(maxAgeMs?: number, now?: number): Promise<boolean> {
  return requireDb().isModelsDevCatalogStale(maxAgeMs, now)
}

export function loadModelsDevSnapshot(): Promise<ModelsDevApi> {
  if (!_snapshotLoader) {
    throw new Error(
      "[provider-core] models.dev snapshot loader not wired — call setModelsDevSnapshotLoader() at boot."
    )
  }
  return _snapshotLoader()
}
