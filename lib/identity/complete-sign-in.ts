/**
 * The whole of signing in, in one call — ADR-0149.
 *
 * Three things have to happen together and none of them is the UI's business:
 * the profile binds to a person (registry), the person is mirrored into the
 * queryable projection (Dexie), and the host is told (SecurityStore). Splitting
 * that across a settings card is how one of them ends up forgotten on the
 * sign-out path.
 *
 * # Failure shape
 *
 * The binding is the only step that may refuse: a profile that belongs to
 * somebody else raises `UserBindingError`, and nothing after it runs. The host
 * mirror is best-effort in the other direction — a desktop whose companion
 * server has never started has no SecurityStore, which is normal, so a failure
 * there is logged and does not undo a sign-in the user just completed.
 */

import { getActiveAccountId } from "@/lib/accounts/active-account-id"

import { identityProjection } from "./identity-projection"
import { bindHostPerson, unbindHostPerson, type HostPersonDeps } from "./host-person"
import {
  bindSignedInIdentity,
  type IdentityProjectionWriter,
  type SignedInIdentity,
} from "./sign-in"
import { UserBindingRegistry } from "./user-binding"

import type { LogtoSession } from "@/lib/logto/client"
import type { UserBindingRow } from "@/lib/accounts/account-db"

export interface CompleteSignInDeps {
  /** Defaults to the profile this runtime is serving. */
  localAccountId?: string
  registry?: UserBindingRegistry
  projection?: IdentityProjectionWriter
  host?: HostPersonDeps
  takeOverProfile?: boolean
  now?: () => number
  onHostMirrorFailed?: (error: unknown) => void
}

function reportHostFailure(deps: CompleteSignInDeps, error: unknown): void {
  if (deps.onHostMirrorFailed) {
    deps.onHostMirrorFailed(error)
    return
  }
  console.warn("[identity] could not mirror the signed-in person to the host", error)
}

/** Bind the profile, fill the projection, and tell the host. */
export async function completeSignIn(
  session: LogtoSession,
  deps: CompleteSignInDeps = {}
): Promise<SignedInIdentity> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()

  const identity = await bindSignedInIdentity(session, {
    localAccountId,
    registry: deps.registry,
    projection: deps.projection ?? identityProjection,
    ...(deps.takeOverProfile ? { takeOverProfile: true } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  })

  try {
    await bindHostPerson(
      {
        localAccountId,
        userId: identity.user.id,
        ...(identity.org ? { orgId: identity.org.id } : {}),
      },
      deps.host ?? {}
    )
  } catch (error) {
    reportHostFailure(deps, error)
  }

  return identity
}

/**
 * Sign out: drop the binding and tell the host to forget the person.
 *
 * Deliberately leaves the projection alone. Those rows are a cache of who
 * people ARE, not of who is signed in — clearing them would blank every name on
 * an issue the moment somebody signed out, and they are re-filled from the
 * server anyway.
 */
export async function completeSignOut(deps: CompleteSignInDeps = {}): Promise<void> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const registry = deps.registry ?? new UserBindingRegistry()

  await registry.unbind(localAccountId)

  try {
    await unbindHostPerson(localAccountId, deps.host ?? {})
  } catch (error) {
    reportHostFailure(deps, error)
  }
}

/** Who is signed into this profile, or `null`. */
export async function readSignedInPerson(
  deps: CompleteSignInDeps = {}
): Promise<UserBindingRow | null> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const registry = deps.registry ?? new UserBindingRegistry()
  return registry.get(localAccountId)
}
