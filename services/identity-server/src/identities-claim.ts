/**
 * The person's linked sign-in identities, published as the `cognia_identities`
 * claim (ADR-0215 §2).
 *
 * A self-hosted deployment learns these from its collaboration server reading
 * the Logto Management API. A personal official account has no collaboration
 * server, so the issuer says it itself: the client links each identity onto
 * its local `User` (`lib/identity/link-signed-in-identities.ts`), which is how
 * a Feishu bot recognizes the signed-in owner as `lark:<tenant_key>:<union_id>`.
 *
 * Only the provider, its stable subject and its tenant are published: never a
 * provider token, never an email.
 */

import type { OAuthProviderExtension } from "@better-auth/oauth-provider"

export const IDENTITIES_CLAIM = "cognia_identities"

export interface PublishedIdentity {
  /** The client's vocabulary: `lark` for Feishu, else the Better Auth provider id. */
  provider: string
  /** Feishu: the union id. Others: the provider's account id. */
  subject: string
  /** Feishu's tenant key. */
  tenant?: string
}

export interface AccountRow {
  providerId: string
  accountId: string
}

/** The providers whose accounts are published; the password `credential` row never is. */
const PUBLISHED_PROVIDERS = new Set(["feishu", "github", "google", "apple"])

export function identitiesFromAccounts(accounts: readonly AccountRow[]): PublishedIdentity[] {
  const identities: PublishedIdentity[] = []
  const seen = new Set<string>()
  for (const account of accounts) {
    if (!PUBLISHED_PROVIDERS.has(account.providerId)) continue
    let identity: PublishedIdentity
    if (account.providerId === "feishu") {
      const separator = account.accountId.indexOf(":")
      // A Feishu account without a tenant cannot be told apart from an open
      // id on the client, so it is left out rather than guessed.
      if (separator <= 0 || separator === account.accountId.length - 1) continue
      identity = {
        provider: "lark",
        tenant: account.accountId.slice(0, separator),
        subject: account.accountId.slice(separator + 1),
      }
    } else {
      if (!account.accountId) continue
      identity = { provider: account.providerId, subject: account.accountId }
    }
    const key = `${identity.provider}\u0000${identity.tenant ?? ""}\u0000${identity.subject}`
    if (seen.has(key)) continue
    seen.add(key)
    identities.push(identity)
  }
  return identities
}

type ClaimContext = Parameters<
  NonNullable<NonNullable<OAuthProviderExtension["claims"]>["idToken"]>
>[0]["ctx"]

async function claimFor(
  ctx: ClaimContext,
  userId: string | undefined,
  scopes: readonly string[]
): Promise<Record<string, unknown>> {
  // Linked identities are profile information: no `profile` scope, no claim.
  if (!userId || !scopes.includes("profile")) return {}
  const accounts = (await ctx.context.internalAdapter.findAccounts(userId)) as AccountRow[]
  return { [IDENTITIES_CLAIM]: identitiesFromAccounts(accounts) }
}

/** The oauth-provider extension that adds the claim to ID tokens and UserInfo. */
export const identitiesClaimExtension: OAuthProviderExtension = {
  claims: {
    idToken: ({ ctx, user, scopes }) => claimFor(ctx, user?.id, scopes),
    userInfo: ({ ctx, user, scopes }) => claimFor(ctx, user.id, scopes),
  },
}
