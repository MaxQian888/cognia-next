/**
 * Whether this build shows account sync (ADR-0215 phase 2): device keys, the
 * sync recovery key and approving new devices.
 *
 * DORMANT BY DEFAULT. Phase 2 enrolls devices but syncs no data, so the
 * feature stays out of production builds until phase 3 has something to
 * sync. It is on when `NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC` is `1`/`true`/`on`
 * (staging builds set it), and in `next dev` unless that variable says
 * `0`/`false`/`off`. With the flag off nothing mounts, nothing polls and
 * nothing talks to the sync host: the account page names the feature as
 * "not in this build" (`AccountSyncSummary`), and `feature-flag.test.ts`,
 * the section's and the poller's tests pin that.
 */

export interface AccountSyncFlagEnv {
  flag?: string
  nodeEnv?: string
}

/** Next inlines only literal `process.env.NEXT_PUBLIC_*` reads into the static export. */
function buildEnv(): AccountSyncFlagEnv {
  return { flag: process.env.NEXT_PUBLIC_COGNIA_ACCOUNT_SYNC, nodeEnv: process.env.NODE_ENV }
}

export function accountSyncEnabled(env: AccountSyncFlagEnv = buildEnv()): boolean {
  const flag = env.flag?.trim().toLowerCase()
  if (flag === "1" || flag === "true" || flag === "on") return true
  if (flag === "0" || flag === "false" || flag === "off") return false
  return env.nodeEnv === "development"
}
