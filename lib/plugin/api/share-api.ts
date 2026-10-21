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

import { createShareLink, revokeShareLink, getShareStats } from "@/lib/share/client"
import { listSharedLinks, getSharedLinkByCode, deleteSharedLink } from "@/lib/db/shared-links"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import type { PluginShareAPI } from "@cognia/plugin-contract/lib/plugin/api/share-api"
export type { PluginShareAPI } from "@cognia/plugin-contract/lib/plugin/api/share-api"

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
