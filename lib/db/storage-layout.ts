/**
 * The storage-layout marker: proof that a local database was created by the
 * schema this build declares, rather than by an older one.
 *
 * `lib/db/schema.ts` no longer carries a version chain, so there are no
 * `upgrade()` hooks to carry a pre-existing database forward. Dexie would still
 * happily open one: raising the declared version creates the missing stores and
 * leaves every existing row untouched, which looks like a clean upgrade and is
 * not one. Rows written under the old layout keep their old shape, and the code
 * reading them assumes the new shape.
 *
 * So the marker is the gate. A database that does not carry one was written by
 * a layout this build cannot reason about, and boot refuses it instead of
 * opening it and being subtly wrong. Refusing is not deleting: the data stays
 * on disk and the user chooses whether to reset.
 *
 * The probe deliberately opens with NO version declared (Dexie's dynamic mode),
 * because declaring one is the very act that would upgrade the database we are
 * trying to inspect.
 */

import Dexie from "dexie"

import { CURRENT_SCHEMA_VERSION } from "./schema"

/**
 * Identifies the storage ARCHITECTURE, not the schema version. Change it when
 * the set or the ownership of databases changes (for example when profile and
 * target data split into separate databases), which invalidates every database
 * written under the previous arrangement.
 */
export const STORAGE_LAYOUT = "single-database"

export const STORAGE_LAYOUT_TABLE = "storageLayout"
export const STORAGE_LAYOUT_ID = "singleton"

export interface StorageLayoutMarker {
  id: typeof STORAGE_LAYOUT_ID
  layout: string
  schemaVersion: number
  writtenAt: number
}

export type UnsupportedLocalSchemaReason =
  /** No marker store at all, so the database predates the marker entirely. */
  | "missing-marker"
  /** Written under a different storage architecture. */
  | "layout-mismatch"
  /** Written by a newer build. Opening it would not downgrade the rows. */
  | "newer-schema"

export class UnsupportedLocalSchemaError extends Error {
  readonly name = "UnsupportedLocalSchemaError"
  readonly databaseName: string
  readonly reason: UnsupportedLocalSchemaReason
  readonly found?: { layout?: string; schemaVersion?: number }

  constructor(
    databaseName: string,
    reason: UnsupportedLocalSchemaReason,
    found?: { layout?: string; schemaVersion?: number }
  ) {
    super(
      `Local database ${databaseName} was not written by this build (${reason}). ` +
        `Expected layout ${STORAGE_LAYOUT} at schema version ${CURRENT_SCHEMA_VERSION} or lower.`
    )
    this.databaseName = databaseName
    this.reason = reason
    this.found = found
  }
}

export interface StorageLayoutDependencies {
  databaseExists: (databaseName: string) => Promise<boolean>
  openProbe: (databaseName: string) => Dexie
  deleteDatabase: (databaseName: string) => Promise<void>
}

const defaultDependencies: StorageLayoutDependencies = {
  databaseExists: (databaseName) => Dexie.exists(databaseName),
  // No `.version()` call: Dexie opens at whatever version is on disk and
  // reports the stores it finds, without triggering an upgrade.
  openProbe: (databaseName) => new Dexie(databaseName),
  deleteDatabase: (databaseName) => Dexie.delete(databaseName),
}

/**
 * Throw unless the database on disk is one this build may open.
 *
 * Silent success covers two shapes that are both fine:
 *   - the database does not exist yet, so opening it creates it, and
 *   - the marker STORE exists but holds no row, which is the window between
 *     this build creating the database and `writeStorageLayoutMarker` running.
 *     Only a missing store means "written by an older layout".
 */
export async function assertStorageLayoutSupported(
  databaseName: string,
  dependencies: StorageLayoutDependencies = defaultDependencies
): Promise<void> {
  if (!(await dependencies.databaseExists(databaseName))) return

  const probe = dependencies.openProbe(databaseName)
  try {
    await probe.open()
    if (!probe.tables.some((table) => table.name === STORAGE_LAYOUT_TABLE)) {
      throw new UnsupportedLocalSchemaError(databaseName, "missing-marker")
    }
    const marker = (await probe.table(STORAGE_LAYOUT_TABLE).get(STORAGE_LAYOUT_ID)) as
      StorageLayoutMarker | undefined
    if (!marker) return
    if (marker.layout !== STORAGE_LAYOUT) {
      throw new UnsupportedLocalSchemaError(databaseName, "layout-mismatch", {
        layout: marker.layout,
        schemaVersion: marker.schemaVersion,
      })
    }
    // A LOWER stored version is an ordinary forward move within this layout:
    // the new declaration adds stores and leaves rows alone. Only a higher one
    // is unsafe, because this build cannot know what the newer one changed.
    if (marker.schemaVersion > CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedLocalSchemaError(databaseName, "newer-schema", {
        layout: marker.layout,
        schemaVersion: marker.schemaVersion,
      })
    }
  } finally {
    probe.close()
  }
}

/** Stamp the open database as belonging to this build. Idempotent. */
export async function writeStorageLayoutMarker(database: {
  table: (name: string) => { put: (row: StorageLayoutMarker) => Promise<unknown> }
}): Promise<void> {
  await database.table(STORAGE_LAYOUT_TABLE).put({
    id: STORAGE_LAYOUT_ID,
    layout: STORAGE_LAYOUT,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    writtenAt: Date.now(),
  })
}

/**
 * Destroy a refused database so the next boot starts clean.
 *
 * Only ever called from an explicit user action. Deletion is verified, because
 * a delete that silently did nothing would loop the user through the same
 * refusal on every launch with no way out.
 */
export async function resetLocalDatabase(
  databaseName: string,
  dependencies: StorageLayoutDependencies = defaultDependencies
): Promise<void> {
  await dependencies.deleteDatabase(databaseName)
  if (await dependencies.databaseExists(databaseName)) {
    throw new Error(`Local database ${databaseName} could not be deleted.`)
  }
}
