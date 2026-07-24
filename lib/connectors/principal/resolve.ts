/**
 * Principal resolution for Lark inbound events and callbacks
 * (plan 2026-07-24 Phase 1, §3.2).
 *
 * Maps the verified envelope's `tenantKey + appId + openId` to a registered
 * `FeishuPrincipalRow` and its Cognia account. FAIL CLOSED: whenever the
 * `larkPrincipalRegistry` flag is on and the sender cannot be positively
 * resolved to the currently active account, the event must not create an
 * agent turn and must never fall back to the default local account — callers
 * route every non-`resolved` outcome through `handleUnresolvedPrincipal`.
 */

import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { FeishuPrincipalRow, FeishuTenantRow } from "@/lib/db/connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { ACCOUNT_DB_PREFIX } from "@/lib/accounts/account-db"
import {
  getFeishuPrincipal,
  getFeishuTenant,
  touchFeishuPrincipalVerification,
} from "@/lib/db/feishu-principals"
import { getDb } from "@/lib/db/schema"
import { isLarkPrincipalRegistryEnabled } from "../feature-flags"

/**
 * Must stay in lockstep with `HEADLESS_LOCAL_ACCOUNT_ID` in
 * `cli/src/serve/account.ts` and `src-tauri/src/bin/cognia-server.rs` (lib
 * code cannot import from cli/).
 */
const DEFAULT_LOCAL_ACCOUNT_ID = "local_acct_a"

export interface IdentityScope {
  tenantKey?: string
  appId?: string
}

export type PrincipalResolution =
  | {
      status: "resolved"
      principal: FeishuPrincipalRow
      tenant: FeishuTenantRow
      accountId: string
    }
  /** Registry flag off, or non-Lark platform — today's behavior, no gating. */
  | { status: "legacy" }
  | { status: "unbound"; tenantKey?: string; appId?: string; openIdHash: string }
  | { status: "principal_disabled"; principal: FeishuPrincipalRow }
  | { status: "tenant_disabled"; tenant: FeishuTenantRow }
  /** Registry maps the sender to a DIFFERENT account than this runtime serves. */
  | { status: "cross_account"; declaredAccountId: string }

export interface ResolvePrincipalInput {
  platform: PlatformKind
  adapterRow: Pick<AdapterInstanceRow, "settings" | "lastWhoamiResult">
  /** Lark open_id of the sender / clicker. */
  remoteUserId: string
  identityScope?: IdentityScope
  /** Injectable for tests; defaults to `getActiveRuntimeAccountId()`. */
  activeAccountId?: string
}

/**
 * Audit-safe stand-in for an open_id — sha256 hex, first 12 chars. Web Crypto
 * so it works in the browser, Tauri webview, and the Node headless brain
 * (jsdom tests get `subtle` from jest.setup.ts).
 */
export async function hashOpenId(openId: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("hashOpenId: Web Crypto unavailable")
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(openId))
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12)
}

/**
 * In-memory stamp the bus writes onto `event.channelData` after a positive
 * resolution, so downstream run-creation sites can attribute initiators
 * without re-resolving. Recovery replays re-enter the bus pipeline, which
 * re-stamps — the registry stays the authority, never this denorm.
 */
export interface ResolvedPrincipalStamp {
  principalId: string
  accountId: string
}

/** Typed reader for the `channelData.resolvedPrincipal` stamp set by the bus. */
export function readResolvedPrincipal(
  channelData: Record<string, unknown> | undefined
): ResolvedPrincipalStamp | undefined {
  const raw = channelData?.resolvedPrincipal
  if (!raw || typeof raw !== "object") return undefined
  const stamp = raw as Record<string, unknown>
  if (typeof stamp.principalId !== "string" || typeof stamp.accountId !== "string") return undefined
  return { principalId: stamp.principalId, accountId: stamp.accountId }
}

/** Typed reader for the `channelData.identityScope` stamp set by the parser. */
export function readIdentityScope(
  channelData: Record<string, unknown> | undefined
): IdentityScope | undefined {
  const raw = channelData?.identityScope
  if (!raw || typeof raw !== "object") return undefined
  const scope = raw as Record<string, unknown>
  const tenantKey = typeof scope.tenantKey === "string" ? scope.tenantKey : undefined
  const appId = typeof scope.appId === "string" ? scope.appId : undefined
  if (!tenantKey && !appId) return undefined
  return { tenantKey, appId }
}

/**
 * Account scope this runtime is currently serving. The brain/desktop operates
 * exactly one account database at a time, so the active Dexie database name
 * IS the authoritative scope every registry lookup runs in. Falls back to the
 * headless default for the legacy (pre-multi-account) database name.
 */
export function getActiveRuntimeAccountId(): string {
  try {
    const name = getDb().name
    if (name.startsWith(ACCOUNT_DB_PREFIX)) return name.slice(ACCOUNT_DB_PREFIX.length)
  } catch {
    // getDb() throws outside the browser/brain runtime (SSR pre-render);
    // resolution never runs there, but keep the fallback total.
  }
  return process.env.COGNIA_LOCAL_ACCOUNT_ID ?? DEFAULT_LOCAL_ACCOUNT_ID
}

// Throttle lastVerifiedAt writes to once per principal per hour.
const VERIFICATION_TOUCH_INTERVAL_MS = 60 * 60 * 1000

export async function resolveConnectorPrincipal(
  input: ResolvePrincipalInput
): Promise<PrincipalResolution> {
  if (input.platform !== "lark") return { status: "legacy" }
  if (!isLarkPrincipalRegistryEnabled(input.adapterRow)) return { status: "legacy" }

  const openId = input.remoteUserId
  const openIdHash = await hashOpenId(openId)
  const tenantKey = input.identityScope?.tenantKey
  // The envelope header omits app_id on some event generations; the adapter's
  // whoami probe knows which app THIS adapter is, so it is a safe fallback.
  // tenantKey has no such fallback: guessing it from whoami would merge
  // cross-tenant (external-group) senders into the home tenant — refuse.
  const appId = input.identityScope?.appId ?? input.adapterRow.lastWhoamiResult?.appId
  if (!tenantKey || !appId) {
    return { status: "unbound", tenantKey, appId, openIdHash }
  }

  const tenant = await getFeishuTenant(tenantKey, appId)
  if (!tenant) return { status: "unbound", tenantKey, appId, openIdHash }
  if (tenant.status === "disabled") return { status: "tenant_disabled", tenant }

  const principal = await getFeishuPrincipal(tenantKey, appId, openId)
  if (!principal) return { status: "unbound", tenantKey, appId, openIdHash }
  if (principal.status !== "active") return { status: "principal_disabled", principal }

  const activeAccountId = input.activeAccountId ?? getActiveRuntimeAccountId()
  if (principal.cogniaAccountId !== activeAccountId || tenant.cogniaAccountId !== activeAccountId) {
    return {
      status: "cross_account",
      declaredAccountId:
        principal.cogniaAccountId !== activeAccountId
          ? principal.cogniaAccountId
          : tenant.cogniaAccountId,
    }
  }

  const now = Date.now()
  if (
    !principal.lastVerifiedAt ||
    now - principal.lastVerifiedAt > VERIFICATION_TOUCH_INTERVAL_MS
  ) {
    // Best-effort freshness marker; never blocks resolution.
    await touchFeishuPrincipalVerification(principal.id, now).catch(() => undefined)
  }

  return { status: "resolved", principal, tenant, accountId: activeAccountId }
}
