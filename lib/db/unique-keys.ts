import type { Collection, IndexableTypeArray } from "dexie"

/**
 * `Collection.uniqueKeys()` that survives WebKit's empty unique cursor.
 *
 * WebKit (the desktop and iOS WKWebView shells, Safari) fails a `nextunique` /
 * `prevunique` cursor whose range matches no record with
 * `UnknownError: Unable to open cursor` instead of resolving with no cursor.
 * Dexie's `uniqueKeys()` opens exactly that cursor, so a distinct-key read over
 * an empty table or an unmatched `anyOf` throws there. A plain cursor over the
 * same range works, so on that error re-check with one: an empty range yields
 * `[]`, anything else (another error, or records present) rethrows. Catching
 * inside a Dexie transaction keeps the transaction alive.
 */
export async function uniqueIndexKeys<T, TKey>(
  collection: Collection<T, TKey>
): Promise<IndexableTypeArray> {
  // Run it on a clone: `uniqueKeys()` marks its own collection unique, and a
  // clone's context inherits from its source's, so the probe below (cloned from
  // the untouched original) must not see that flag.
  try {
    return await collection.clone().uniqueKeys()
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "UnknownError") throw error
    if ((await collection.clone().limit(1).keys()).length === 0) return []
    throw error
  }
}
