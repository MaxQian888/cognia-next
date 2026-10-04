/**
 * Signing in to the official Cognia account: a person, no organization
 * (ADR-0215 §2).
 *
 * A self-hosted deployment's sign-in ends in an organization: the
 * collaboration server lists the person's memberships and one is adopted
 * (`cloud-sign-in-flow.ts`). The official account is personal. There is no
 * collaboration server to ask and nothing to adopt, so a sign-in is complete
 * once the profile is bound to the person and the person's linked sign-ins
 * are joined to the people the IM adapters already know:
 *
 * 1. PKCE against the official issuer, straight to the provider the person
 *    pressed (`provider=`), the session saved to the keyring;
 * 2. `completeSignIn`: the profile binding (the issuer's `usr_` subject IS
 *    the person's id), the projection, and the desktop host;
 * 3. the ID token's `cognia_identities` linked onto that person, and the
 *    Feishu principals whose union id matches learn the login's subject.
 *
 * Step 3 is best-effort, exactly as it is after adopting an organization: a
 * failure leaves the person signed in and unjoined.
 */

import { completeSignIn, type CompleteSignInDeps } from "./complete-sign-in"
import { issuerIdentities } from "./issuer-identities"
import {
  linkSignedInIdentities,
  type IdentityConflict,
  type LinkSignedInIdentitiesReport,
} from "./link-signed-in-identities"
import {
  officialLogtoConfig,
  type OfficialConfigOptions,
  type OfficialDeployment,
} from "./official-deployment"
import type { SignedInIdentity } from "./sign-in"

import { attachSignInToFeishuPrincipals } from "@/lib/connectors/principal/login-link"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import { signInToLogto } from "@/lib/logto/app-session"

import type { CollabExternalIdentity } from "@/lib/collab/client"
import type { LogtoDrivers, LogtoSession } from "@/lib/logto/client"

export interface PersonalSignInDeps {
  localAccountId?: string
  signIn?: typeof signInToLogto
  complete?: (session: LogtoSession, deps: CompleteSignInDeps) => Promise<SignedInIdentity>
  linkIdentities?: (input: {
    userId: string
    identities: readonly CollabExternalIdentity[]
  }) => Promise<LinkSignedInIdentitiesReport>
  attachPrincipals?: typeof attachSignInToFeishuPrincipals
  now?: () => number
}

export interface PersonalSignIn {
  session: LogtoSession
  identity: SignedInIdentity
  /**
   * Linked sign-ins that already belong to ANOTHER local user. Nothing was
   * merged: two Users for one human is a migration a person confirms.
   */
  identityConflicts: IdentityConflict[]
}

/** Bind the profile to the person a fresh official session names, and join their sign-ins. */
export async function settlePersonalSignIn(
  session: LogtoSession,
  deps: PersonalSignInDeps = {}
): Promise<PersonalSignIn> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const now = deps.now ?? Date.now
  const identity = await (deps.complete ?? completeSignIn)(session, { localAccountId })

  let identityConflicts: IdentityConflict[] = []
  const identities = issuerIdentities(session)
  if (identities.length > 0) {
    try {
      const report = await (deps.linkIdentities ?? linkSignedInIdentities)({
        userId: identity.user.id,
        identities,
      })
      identityConflicts = report.conflicts
      if (identityConflicts.length > 0) {
        console.warn("[identity] linked sign-ins already belong to another user", identityConflicts)
      }
      const logtoSubject = identity.binding.logtoSubject
      if (logtoSubject && report.linked.length > 0) {
        const attached = await (deps.attachPrincipals ?? attachSignInToFeishuPrincipals)({
          userId: identity.user.id,
          logtoSubject,
          identities: report.linked,
          now: now(),
        })
        if (attached.foreign.length > 0) {
          console.warn(
            "[identity] Feishu principals matching the sign-in belong to another user",
            attached.foreign
          )
        }
      }
    } catch (error) {
      console.warn("[identity] could not link the official account's sign-ins", error)
    }
  }
  return { session, identity, identityConflicts }
}

/** Sign in to the official account and settle the person. */
export async function signInToOfficialAccount(
  deployment: OfficialDeployment,
  drivers: LogtoDrivers,
  options: OfficialConfigOptions,
  deps: PersonalSignInDeps = {}
): Promise<PersonalSignIn> {
  const localAccountId = deps.localAccountId ?? getActiveAccountId()
  const session = await (deps.signIn ?? signInToLogto)(
    officialLogtoConfig(deployment, options),
    drivers,
    { localAccountId }
  )
  return settlePersonalSignIn(session, { ...deps, localAccountId })
}
