// Storybook-only IndexedDB helpers. Components that read Dexie via `useLiveQuery`
// open a REAL (empty) IndexedDB in the Storybook browser — they render their
// loading/empty state without crashing. For stories where empty state is
// uninteresting, seed concrete rows in an async `beforeEach`.
//
// The reset path mirrors what the repo's Dexie tests do
// (`await getDb().delete(); __resetDbForTesting()`), so story order can't leak
// rows between renders.
import { getDb, __resetDbForTesting, whenSeeded } from "@/lib/db/schema"

type CogniaDB = ReturnType<typeof getDb>

/** Drop the database and the cached instance so the next `getDb()` reopens fresh. */
export async function clearDb(): Promise<void> {
  await getDb().delete()
  __resetDbForTesting()
}

/**
 * Reset to a fresh database, let the built-in seed (characters/skills/teams)
 * finish, then run `fill` to insert story-specific rows. Use in an async
 * `beforeEach`; pair with the fixture builders in `./fixtures`.
 */
export async function seedDb(fill: (db: CogniaDB) => Promise<void> | void): Promise<void> {
  await clearDb()
  // Re-open + kick off the built-in seed, then wait for it so list views that
  // also surface seed rows render deterministically.
  await whenSeeded()
  await fill(getDb())
}
