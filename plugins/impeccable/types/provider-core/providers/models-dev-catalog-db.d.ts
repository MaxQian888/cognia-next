import {
  NormalizedModelsDevProvider,
  NormalizedModelsDevCatalog,
  ModelsDevApi,
} from "./models-dev.js"
import "@cognia/provider-types/built-in-provider-catalog"
import "@cognia/provider-types/model-catalog"
import "@cognia/provider-types/provider"

interface ModelsDevCatalogRow {
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
interface ModelsDevCatalogDb {
  getModelsDevCatalog(): Promise<ModelsDevCatalogRow | undefined>
  saveModelsDevCatalog(input: {
    providers: NormalizedModelsDevCatalog
    fetchedAt: number
    source: ModelsDevCatalogRow["source"]
  }): Promise<ModelsDevCatalogRow>
  isModelsDevCatalogStale(maxAgeMs?: number, now?: number): Promise<boolean>
}
type ModelsDevSnapshotLoader = () => Promise<ModelsDevApi>
/** Catalog staleness window — 7 days. Mirrors the host constant. */
declare const MODELS_DEV_STALE_MS: number
/** Wire the host's Dexie-backed catalog store. Called once at app boot. */
declare function setModelsDevCatalogDb(db: ModelsDevCatalogDb): void
declare function setModelsDevSnapshotLoader(loader: ModelsDevSnapshotLoader): void
declare function getModelsDevCatalog(): Promise<ModelsDevCatalogRow | undefined>
declare function saveModelsDevCatalog(
  input: Parameters<ModelsDevCatalogDb["saveModelsDevCatalog"]>[0]
): Promise<ModelsDevCatalogRow>
declare function isModelsDevCatalogStale(maxAgeMs?: number, now?: number): Promise<boolean>
declare function loadModelsDevSnapshot(): Promise<ModelsDevApi>

export {
  MODELS_DEV_STALE_MS,
  type ModelsDevCatalogDb,
  type ModelsDevCatalogRow,
  type ModelsDevSnapshotLoader,
  getModelsDevCatalog,
  isModelsDevCatalogStale,
  loadModelsDevSnapshot,
  saveModelsDevCatalog,
  setModelsDevCatalogDb,
  setModelsDevSnapshotLoader,
}
