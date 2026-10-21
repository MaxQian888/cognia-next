/**
 * The plugin contract's share of `lib/plugin/api/share-api.ts`, which re-exports these.
 */
import type { CreateShareInput, CreatedShare } from "../../share/client"
import type { ShareStats } from "../../share/types"
import type { SharedLinkRow } from "../../db/shared-links"

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
