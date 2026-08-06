import type { CdpAuditEvent, CdpCapability, CdpGrant } from "@/types/browser-developer"
import { isTauri } from "@/lib/platform/detect"
import { appendCdpAuditEvent, getActiveCdpGrant, normalizeCdpOrigin } from "@/lib/db/browser-cdp"

export interface CdpAccessRequest {
  grantId: string
  sessionId: string
  browserSessionId: string
  pageUrl: string
  capability: CdpCapability
  method: string
  executionTarget: "local" | "remote" | "companion" | "cloud"
}

export type CdpAuthorizationReason =
  | "allowed"
  | "tauri_required"
  | "local_target_required"
  | "invalid_origin"
  | "grant_missing_or_inactive"

export interface CdpAuthorizationDecision {
  allowed: boolean
  reason: CdpAuthorizationReason
  grant?: CdpGrant
}

interface CdpPolicyDeps {
  isTauriRuntime: () => boolean
  now: () => number
  createAuditId: () => string
  findGrant: typeof getActiveCdpGrant
  appendAudit: typeof appendCdpAuditEvent
}

const defaultDeps: CdpPolicyDeps = {
  isTauriRuntime: isTauri,
  now: Date.now,
  createAuditId: () => crypto.randomUUID(),
  findGrant: getActiveCdpGrant,
  appendAudit: appendCdpAuditEvent,
}

async function auditDecision(
  request: CdpAccessRequest,
  origin: string,
  reason: CdpAuthorizationReason,
  deps: CdpPolicyDeps
): Promise<void> {
  const event: CdpAuditEvent = {
    id: deps.createAuditId(),
    grantId: request.grantId,
    sessionId: request.sessionId,
    browserSessionId: request.browserSessionId,
    origin,
    capability: request.capability,
    method: request.method,
    outcome: reason === "allowed" ? "used" : "rejected",
    reason: reason === "allowed" ? undefined : reason,
    createdAt: deps.now(),
  }
  await deps.appendAudit(event)
}

/**
 * Fail-closed CDP gate. The renderer may request access, but only a local Tauri
 * browser with an exact, active session grant reaches the native executor.
 */
export async function authorizeCdpAccess(
  request: CdpAccessRequest,
  overrides: Partial<CdpPolicyDeps> = {}
): Promise<CdpAuthorizationDecision> {
  const deps = { ...defaultDeps, ...overrides }
  let origin: string
  try {
    origin = normalizeCdpOrigin(request.pageUrl)
  } catch {
    // Audit rows require a valid origin. Use an opaque sentinel rather than
    // persisting the malformed URL, which may contain credentials or tokens.
    origin = "http://invalid.local"
    await auditDecision(request, origin, "invalid_origin", deps)
    return { allowed: false, reason: "invalid_origin" }
  }

  if (!deps.isTauriRuntime()) {
    await auditDecision(request, origin, "tauri_required", deps)
    return { allowed: false, reason: "tauri_required" }
  }
  if (request.executionTarget !== "local") {
    await auditDecision(request, origin, "local_target_required", deps)
    return { allowed: false, reason: "local_target_required" }
  }

  const grant = await deps.findGrant({
    id: request.grantId,
    sessionId: request.sessionId,
    browserSessionId: request.browserSessionId,
    origin,
    capability: request.capability,
    now: deps.now(),
  })
  if (!grant) {
    await auditDecision(request, origin, "grant_missing_or_inactive", deps)
    return { allowed: false, reason: "grant_missing_or_inactive" }
  }

  await auditDecision(request, origin, "allowed", deps)
  return { allowed: true, reason: "allowed", grant }
}
