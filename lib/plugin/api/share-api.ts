/**
 * Plugin Share API (`ctx.share`) — create / revoke / inspect the app's
 * zero-knowledge public share links (ADR-0037) from a plugin.
 *
 * Wraps the owner-side `lib/share/client.ts` service + the local Dexie
 * mirror (`lib/db/shared-links.ts`). The encryption key never leaves the
 * client — `create` returns the full URL (with the `#k=` fragment); the
 * worker only ever stores the opaque encrypted envelope.
 *
 * SAFETY: `create`/`revoke`/`delete` mutate public state — creating a link
 * publishes (encrypted) data to the external share worker, so they need
 * `share:create` (a `DANGEROUS` permission: outward-facing egress).
 * Listing the local mirror + reading owner stats is `share:read`.
 */

import {
  createShareLink,
  revokeShareLink,
  getShareStats,
  type CreateShareInput,
  type CreatedShare,
} from "@/lib/share/client"
import {
  listSharedLinks,
  getSharedLinkByCode,
  deleteSharedLink,
  type SharedLinkRow,
} from "@/lib/db/shared-links"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { ShareStats } from "@/lib/share/types"

export interface PluginShareAPI {
  /** Create an encrypted public share link. Returns code + full URL (with key fragment). */
  create(input: CreateShareInput): Promise<CreatedShare>
  /** Revoke a link on the worker + flag the local mirror. */
  revoke(code: string): Promise<void>
  /** List locally-mirrored share links (excludes revoked unless asked). */
  list(opts?: { includeRevoked?: boolean }): Promise<SharedLinkRow[]>
  /** Look up one mirrored link by code. */
  getByCode(code: string): Promise<SharedLinkRow | null>
  /** Owner-only live stats (view count / expiry / revoked); `null` if gone. */
  getStats(code: string): Promise<ShareStats | null>
  /** Remove the local mirror row (does not touch the worker — use `revoke` for that). */
  delete(code: string): Promise<void>
}

/**
 * Create the Share API for a plugin. `list`/`getByCode`/`getStats` need
 * `share:read`; `create`/`revoke`/`delete` need `share:create`.
 */
export function createShareAPI(pluginId: string): PluginShareAPI {
  const api: PluginShareAPI = {
    create: (input) => createShareLink(input),
    revoke: (code) => revokeShareLink(code),
    list: (opts) => listSharedLinks(opts),
    getByCode: async (code) => (await getSharedLinkByCode(code)) ?? null,
    getStats: (code) => getShareStats(code),
    delete: (code) => deleteSharedLink(code),
  }

  return createGuardedAPI(pluginId, api, {
    list: "share:read",
    getByCode: "share:read",
    getStats: "share:read",
    create: "share:create",
    revoke: "share:create",
    delete: "share:create",
  })
}
