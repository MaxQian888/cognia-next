/**
 * Telling the host which person a profile belongs to (ADR-0149 section 9).
 *
 * The renderer owns the binding: the registry row in
 * `lib/identity/user-binding.ts` is the one a caller reads. This module only
 * mirrors it into `host_bindings`, so the companion API can answer "whose
 * machine is this" for a request that never touches the renderer.
 *
 * # Two ids, one person
 *
 * The host verifies the access token itself and derives the person's id from
 * the issuer and subject, the same way the first sign-in on any machine does.
 * Once a collaboration server has been reached the renderer holds the
 * server's own `usr_` instead, which the host cannot verify. So the mirror
 * sends both: the derived ids, recomputed here from the same token so the
 * host's comparison can hold, and the caller's ids as canonical aliases when
 * they differ. The host stores the aliases without trusting them.
 *
 * # Where the host's trust anchor comes from
 *
 * A headless host reads its issuer from the environment. A desktop has none,
 * so `configureHostDeployment` points it at a gateway and the host fetches the
 * issuer from there itself. Without one of the two, every bind is refused.
 *
 * Off the desktop there is no host to tell, and that is a supported state
 * rather than a degraded one: the browser and Capacitor shells have no
 * SecurityStore at all. Every function here is a no-op there, which keeps
 * sign-in a single code path instead of two.
 */

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/platform/detect"
import { decodeJwtPayload, stringClaim } from "@/lib/security/jwt-payload"

import { deriveOrgId, deriveUserId } from "./sign-in"

export const ACCOUNT_BIND_PERSON_COMMAND = "account_bind_person"
export const ACCOUNT_UNBIND_PERSON_COMMAND = "account_unbind_person"
export const ACCOUNT_PERSON_COMMAND = "account_person"
export const ACCOUNT_SET_CLOUD_DEPLOYMENT_COMMAND = "account_set_cloud_deployment"
export const ACCOUNT_CLEAR_CLOUD_DEPLOYMENT_COMMAND = "account_clear_cloud_deployment"

type InvokeFn = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export interface HostPerson {
  localAccountNamespace: string
  userId: string | null
  orgId: string | null
  /** The server-assigned alias of `userId`, unverified by the host. */
  canonicalUserId?: string | null
  canonicalOrgId?: string | null
}

/** What the host recorded about the deployment it verifies sign-ins against. */
export interface HostCloudDeployment {
  gatewayUrl: string
  fingerprint?: string
  issuer: string
  audience: string
  collaborationServiceUrl?: string
  webOrigin?: string
  savedAt: number
}

export interface HostPersonDeps {
  invokeFn?: InvokeFn
  isDesktop?: () => boolean
}

function resolve(deps: HostPersonDeps) {
  return {
    call: deps.invokeFn ?? (invoke as InvokeFn),
    desktop: (deps.isDesktop ?? isTauri)(),
  }
}

/** The ids the host will derive from this token, or `null` when it cannot. */
export async function derivedPersonFromToken(
  accessToken: string
): Promise<{ userId: string; orgId?: string } | null> {
  const payload = decodeJwtPayload(accessToken)
  const issuer = stringClaim(payload, "iss")
  const subject = stringClaim(payload, "sub")
  if (!issuer || !subject) return null
  const organizationId = stringClaim(payload, "organization_id")
  const userId = await deriveUserId(issuer, subject)
  return organizationId ? { userId, orgId: await deriveOrgId(issuer, organizationId) } : { userId }
}

/**
 * Record the person on the host. Returns whether anything was written, so a
 * caller can tell "no host here" from "the host accepted it" without having to
 * ask what shell it is running in.
 *
 * `userId` / `orgId` are whatever the caller holds for the person, derived or
 * canonical. The derived pair is recomputed from the token, and the caller's
 * ids ride along as aliases only when they are not that pair.
 */
export async function bindHostPerson(
  input: {
    localAccountId: string
    userId: string
    orgId?: string
    accessToken: string
  },
  deps: HostPersonDeps = {}
): Promise<boolean> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return false
  const derived = await derivedPersonFromToken(input.accessToken)
  if (!derived) {
    throw new Error("the access token carries no readable issuer and subject to mirror")
  }
  // No `issuer`/`audience`: the host validates the token against its OWN
  // configured Logto issuer. A renderer that supplies the trust anchor is
  // verifying the token against itself.
  await call<void>(ACCOUNT_BIND_PERSON_COMMAND, {
    accessToken: input.accessToken,
    userId: derived.userId,
    orgId: derived.orgId ?? null,
    canonicalUserId: input.userId !== derived.userId ? input.userId : null,
    canonicalOrgId: input.orgId && input.orgId !== derived.orgId ? input.orgId : null,
  })
  return true
}

export async function unbindHostPerson(
  localAccountId: string,
  deps: HostPersonDeps = {}
): Promise<boolean> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return false
  void localAccountId
  await call<void>(ACCOUNT_UNBIND_PERSON_COMMAND)
  return true
}

/**
 * Read what the host recorded, so a caller can detect a disagreement with the
 * renderer's own binding. `null` means "nothing recorded here" (no host, or a
 * profile the host has never seen unlocked), never "the call failed".
 */
export async function readHostPerson(
  localAccountId: string,
  deps: HostPersonDeps = {}
): Promise<HostPerson | null> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return null
  void localAccountId
  const result = await call<HostPerson | null>(ACCOUNT_PERSON_COMMAND)
  return result ?? null
}

/**
 * Point the host at a cloud deployment. The host fetches the gateway's
 * `/api/auth/config` itself and keeps the issuer it announced: nothing the
 * renderer discovered is passed along, because the host must not take its
 * trust anchor from an argument. `null` off the desktop.
 */
export async function configureHostDeployment(
  input: { gatewayUrl: string; fingerprint?: string; replace?: boolean },
  deps: HostPersonDeps = {}
): Promise<HostCloudDeployment | null> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return null
  return call<HostCloudDeployment>(ACCOUNT_SET_CLOUD_DEPLOYMENT_COMMAND, {
    gatewayUrl: input.gatewayUrl,
    fingerprint: input.fingerprint ?? null,
    replace: input.replace ?? false,
  })
}

/** Forget the host's anchor. Bindings already recorded stay as they are. */
export async function clearHostDeployment(deps: HostPersonDeps = {}): Promise<boolean> {
  const { call, desktop } = resolve(deps)
  if (!desktop) return false
  await call<void>(ACCOUNT_CLEAR_CLOUD_DEPLOYMENT_COMMAND)
  return true
}
