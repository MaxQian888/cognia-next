/**
 * `principal_admin` intent executor — the headless operator channel's brain
 * half (plan 2026-07-24 P1.1).
 *
 * `cognia lark …` POSTs to the companion's device/service-JWT-protected
 * `/api/v1/lark/admin`, which publishes a `principal_admin` frame; this module
 * turns that frame into a call on `principal/admin.ts` and returns a
 * JSON-serializable result the CLI prints.
 *
 * The brain performs the write because it owns the account database: headless
 * persistence is fake-indexeddb plus a debounced JSON snapshot, so a second
 * process opening the same snapshot would silently lose whichever write
 * flushed last.
 *
 * Errors are returned as short stable codes, never as raw messages —
 * the CLI prints them and the audit log already holds the detail.
 */

import type { FeishuPrincipalStatus } from "@/lib/db/connector-types"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import {
  approveFeishuBind,
  listFeishuBindRequests,
  listFeishuPrincipals,
  rebindFeishuPrincipalIdentity,
  registerFeishuTenant,
  rejectFeishuBind,
  setFeishuPrincipalEnabled,
  setFeishuTenantEnabled,
  sweepStaleFeishuBindRequests,
} from "./admin"

export interface PrincipalAdminIntent {
  adapterId: string
  op: string
  code?: string
  principalId?: string
  status?: string
  cogniaUserId?: string
}

export type PrincipalAdminOutcome =
  { ok: true; result: Record<string, unknown> } | { ok: false; error: string }

export interface PrincipalAdminIntentDependencies {
  getAdapter: typeof getAdapterInstance
}

const PRINCIPAL_STATUSES: readonly FeishuPrincipalStatus[] = ["active", "disabled", "unlinked"]

function isPrincipalStatus(value: string | undefined): value is FeishuPrincipalStatus {
  return !!value && (PRINCIPAL_STATUSES as readonly string[]).includes(value)
}

/**
 * Tenant scope always comes from the adapter's own verified whoami, never from
 * the CLI payload — an operator-typed tenant key would create a registry row
 * no inbound event can ever match.
 */
async function tenantScopeOf(
  adapterId: string,
  deps: PrincipalAdminIntentDependencies
): Promise<{ tenantKey: string; appId: string } | null> {
  const row = await deps.getAdapter(adapterId)
  const tenantKey = row?.lastWhoamiResult?.tenantKey
  const appId = row?.lastWhoamiResult?.appId
  return tenantKey && appId ? { tenantKey, appId } : null
}

export async function runPrincipalAdminIntent(
  intent: PrincipalAdminIntent,
  overrides: Partial<PrincipalAdminIntentDependencies> = {}
): Promise<PrincipalAdminOutcome> {
  const deps: PrincipalAdminIntentDependencies = {
    getAdapter: getAdapterInstance,
    ...overrides,
  }
  const { adapterId, op } = intent

  try {
    switch (op) {
      case "list": {
        const scope = await tenantScopeOf(adapterId, deps)
        const requests = await listFeishuBindRequests({ adapterId, status: "pending" })
        const principals = scope ? await listFeishuPrincipals(scope.tenantKey, scope.appId) : []
        return {
          ok: true,
          result: {
            tenant: scope,
            requests: requests.map((request) => ({
              code: request.id,
              openId: request.openId,
              tenantKey: request.tenantKey,
              appId: request.appId,
              requestedAt: request.requestedAt,
              expiresAt: request.expiresAt,
            })),
            principals: principals.map((principal) => ({
              id: principal.id,
              openId: principal.openId,
              status: principal.status,
              cogniaUserId: principal.cogniaUserId,
              version: principal.version,
            })),
          },
        }
      }

      case "approve": {
        if (!intent.code) return { ok: false, error: "code_required" }
        const principal = await approveFeishuBind({
          code: intent.code,
          ...(intent.cogniaUserId ? { cogniaUserId: intent.cogniaUserId } : {}),
        })
        return {
          ok: true,
          result: { principalId: principal.id, openId: principal.openId, status: principal.status },
        }
      }

      case "reject": {
        if (!intent.code) return { ok: false, error: "code_required" }
        await rejectFeishuBind(intent.code)
        return { ok: true, result: { code: intent.code, status: "rejected" } }
      }

      case "set-principal-status": {
        if (!intent.principalId) return { ok: false, error: "principal_required" }
        if (!isPrincipalStatus(intent.status)) return { ok: false, error: "status_invalid" }
        const principal = await setFeishuPrincipalEnabled({
          adapterId,
          principalId: intent.principalId,
          status: intent.status,
        })
        return { ok: true, result: { principalId: principal.id, status: principal.status } }
      }

      case "rebind": {
        if (!intent.principalId) return { ok: false, error: "principal_required" }
        if (!intent.cogniaUserId) return { ok: false, error: "user_required" }
        const principal = await rebindFeishuPrincipalIdentity({
          adapterId,
          principalId: intent.principalId,
          patch: { cogniaUserId: intent.cogniaUserId },
        })
        return {
          ok: true,
          result: {
            principalId: principal.id,
            cogniaUserId: principal.cogniaUserId,
            version: principal.version,
          },
        }
      }

      case "register-tenant": {
        const scope = await tenantScopeOf(adapterId, deps)
        if (!scope) return { ok: false, error: "tenant_scope_unknown" }
        const tenant = await registerFeishuTenant({ adapterId, ...scope })
        return {
          ok: true,
          result: { tenantId: tenant.id, ...scope, status: tenant.status },
        }
      }

      case "set-tenant-status": {
        const scope = await tenantScopeOf(adapterId, deps)
        if (!scope) return { ok: false, error: "tenant_scope_unknown" }
        if (intent.status !== "active" && intent.status !== "disabled") {
          return { ok: false, error: "status_invalid" }
        }
        const tenant = await setFeishuTenantEnabled({
          adapterId,
          ...scope,
          enabled: intent.status === "active",
        })
        return { ok: true, result: { tenantId: tenant.id, ...scope, status: tenant.status } }
      }

      case "sweep": {
        const expired = await sweepStaleFeishuBindRequests()
        return { ok: true, result: { expired } }
      }

      default:
        return { ok: false, error: "op_unknown" }
    }
  } catch (err) {
    // The admin layer throws typed messages for real operator mistakes
    // (unknown code, already resolved, no tenant scope). Pass the message
    // through — it is operator-facing configuration state, not user data.
    return { ok: false, error: err instanceof Error ? err.message : "admin_failed" }
  }
}
