/**
 * Plugin SDK — `testing` surface. Test-only, never called in production.
 *
 * `createDbTestFixture()` is the supported way to run a plugin's suite against
 * a real Dexie rather than a hand-rolled fake: it snapshots and restores
 * instead of deleting and reopening the database, which is what stops a run
 * mid-transaction from aborting, and it binds the longer timeout those suites
 * need. Reaching for `getDb()` instead hands the test the entire host schema.
 *
 * The other two are the seams a plugin cannot fake: a session that looks like
 * it arrived from IM (the precondition for anything whose behaviour depends on
 * a remote origin, approval scoping above all), and the callback bindings a
 * rendered approval recorded.
 */

export {
  createDbTestFixture,
  DB_TEST_TIMEOUT_MS,
  listCallbackBindings,
  seedPlatformBoundSession,
  seedRunningInboundJob,
} from "@/lib/plugin/api/testing"

export type {
  DbTestFixture,
  DbTestFixtureOptions,
  SeedPlatformBoundSessionInput,
  SeedRunningInboundJobInput,
} from "@/lib/plugin/api/testing"
