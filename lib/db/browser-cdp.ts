import type { CdpAuditEvent, CdpCapability, CdpGrant } from "@/types/browser-developer"
import { getDb } from "./schema"

export function normalizeCdpOrigin(raw: string): string {
  const url = new URL(raw)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CDP grants require an HTTP(S) origin")
  }
  return url.origin
}

export async function putCdpGrant(grant: CdpGrant): Promise<void> {
  if (grant.expiresAt <= grant.grantedAt)
    throw new Error("CDP grant must expire after it is issued")
  await getDb().cdpGrants.put({ ...grant, origin: normalizeCdpOrigin(grant.origin) })
}

export async function getActiveCdpGrant(input: {
  id: string
  sessionId: string
  browserSessionId: string
  origin: string
  capability: CdpCapability
  now: number
}): Promise<CdpGrant | undefined> {
  const grant = await getDb().cdpGrants.get(input.id)
  if (
    !grant ||
    grant.sessionId !== input.sessionId ||
    grant.browserSessionId !== input.browserSessionId ||
    grant.origin !== normalizeCdpOrigin(input.origin) ||
    grant.revokedAt !== undefined ||
    grant.expiresAt <= input.now ||
    !grant.capabilities.includes(input.capability)
  ) {
    return undefined
  }
  return grant
}

/** Append-only: duplicate ids reject instead of mutating historical evidence. */
export async function appendCdpAuditEvent(event: CdpAuditEvent): Promise<void> {
  await getDb().cdpAuditEvents.add({ ...event, origin: normalizeCdpOrigin(event.origin) })
}

export async function listCdpAuditEvents(sessionId: string): Promise<CdpAuditEvent[]> {
  return getDb().cdpAuditEvents.where("sessionId").equals(sessionId).sortBy("createdAt")
}

export async function revokeCdpGrant(
  grantId: string,
  revokedAt: number,
  auditId: string
): Promise<boolean> {
  const db = getDb()
  return db.transaction("rw", db.cdpGrants, db.cdpAuditEvents, async () => {
    const grant = await db.cdpGrants.get(grantId)
    if (!grant) return false
    if (grant.revokedAt !== undefined) return true
    await db.cdpGrants.update(grantId, { revokedAt })
    await db.cdpAuditEvents.add({
      id: auditId,
      grantId,
      sessionId: grant.sessionId,
      browserSessionId: grant.browserSessionId,
      origin: grant.origin,
      outcome: "revoked",
      createdAt: revokedAt,
    })
    return true
  })
}

export async function deleteExpiredCdpGrants(now: number): Promise<number> {
  return getDb().cdpGrants.where("expiresAt").belowOrEqual(now).delete()
}
