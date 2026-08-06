import { browserClient } from "./client"
import { authorizeCdpAccess, type CdpAccessRequest } from "./cdp-policy"
import {
  appendCdpAuditEvent,
  normalizeCdpOrigin,
  putCdpGrant,
  revokeCdpGrant,
} from "@/lib/db/browser-cdp"
import type { CdpCapability, CdpGrant } from "@/types/browser-developer"

const MAX_GRANT_MS = 60 * 60 * 1000

export async function grantCdpAccess(input: {
  id: string
  sessionId: string
  browserSessionId: string
  pageUrl: string
  capabilities: CdpCapability[]
  durationMs: number
  now?: number
}): Promise<CdpGrant> {
  const grantedAt = input.now ?? Date.now()
  if (input.durationMs <= 0 || input.durationMs > MAX_GRANT_MS) {
    throw new Error("CDP grants must expire within one hour")
  }
  const grant: CdpGrant = {
    id: input.id,
    sessionId: input.sessionId,
    browserSessionId: input.browserSessionId,
    origin: normalizeCdpOrigin(input.pageUrl),
    capabilities: [...new Set(input.capabilities)],
    grantedAt,
    expiresAt: grantedAt + input.durationMs,
  }
  if (grant.capabilities.length === 0) throw new Error("CDP grant requires a capability")

  await browserClient.cdpGrant(grant)
  try {
    await putCdpGrant(grant)
    await appendCdpAuditEvent({
      id: crypto.randomUUID(),
      grantId: grant.id,
      sessionId: grant.sessionId,
      browserSessionId: grant.browserSessionId,
      origin: grant.origin,
      outcome: "granted",
      createdAt: grantedAt,
    })
  } catch (error) {
    await browserClient.cdpRevoke(grant.id).catch(() => undefined)
    throw error
  }
  return grant
}

export async function executeCdpCommand(
  request: CdpAccessRequest,
  params: Record<string, unknown>
): Promise<{ method: string; value: unknown }> {
  const decision = await authorizeCdpAccess(request)
  if (!decision.allowed) throw new Error(`CDP access rejected: ${decision.reason}`)
  try {
    return await browserClient.cdpExecute({ ...request, params })
  } catch (error) {
    await appendCdpAuditEvent({
      id: crypto.randomUUID(),
      grantId: request.grantId,
      sessionId: request.sessionId,
      browserSessionId: request.browserSessionId,
      origin: normalizeCdpOrigin(request.pageUrl),
      capability: request.capability,
      method: request.method,
      outcome: "rejected",
      reason: "native_gate_rejected",
      createdAt: Date.now(),
    })
    throw error
  }
}

export async function revokeCdpAccess(grantId: string, now = Date.now()): Promise<boolean> {
  await browserClient.cdpRevoke(grantId)
  return revokeCdpGrant(grantId, now, crypto.randomUUID())
}
