/**
 * A read credential for one GitHub repository, from the accounts the user
 * connected in Settings → Connections.
 *
 * The write path (`action-runner.ts`) has always resolved its token from an
 * integration account. The read path — issue mirror and import, PR observation,
 * stack publishing, thread PR watch, review — used to know only `gh auth token`,
 * so a user who followed "connect an account" was still told there was no
 * credential. This is the second source those readers consult first.
 *
 * Host-scoped (ADR-0176): only an account whose configured deployment is the
 * repository's deployment is a candidate. Sending a github.com token to a GHES
 * server, or the reverse, is exactly what the per-account host exists to stop.
 *
 * Order among candidates on the right host:
 *   1. a GitHub App account installed on the repository's owner — an
 *      installation token only reaches the repositories of its installation;
 *   2. a PAT account — scoped to the user, so it reaches whatever they can;
 *   3. any other App account on that host, last, because it most likely does
 *      not cover this owner and would only produce a 404.
 * Accounts that are disabled or whose credential is known revoked are skipped.
 */

import { listAllIntegrationAccounts } from "@/lib/db/integrations"
import { GITHUB_DOT_COM, type GithubHost } from "@/lib/github/host"
import { getProvider } from "@/lib/plugin/auth/auth-provider-registry"
import type { IntegrationAccount } from "@/types/plugin/plugin-integration"

const GITHUB_PROVIDER_IDS = new Set(["github-app", "github-pat"])

export interface GithubReadCredentialDeps {
  listAccounts: () => Promise<IntegrationAccount[]>
  hostForSession: (sessionId: string) => Promise<GithubHost | undefined>
  resolveToken: (account: IntegrationAccount, host: GithubHost) => Promise<string | null>
}

async function defaultHostForSession(sessionId: string): Promise<GithubHost | undefined> {
  const { githubHostForSession } = await import("./github-auth")
  return githubHostForSession(sessionId)
}

async function defaultResolveToken(
  account: IntegrationAccount,
  host: GithubHost
): Promise<string | null> {
  const provider = getProvider(account.providerId)
  if (!provider?.resolveRequestCredential) return null
  const credential = await provider.resolveRequestCredential(account.authSessionId, {
    accountId: account.id,
    origin: new URL(host.apiBaseUrl).origin,
  })
  return credential.accessToken || null
}

const DEFAULT_DEPS: GithubReadCredentialDeps = {
  listAccounts: () => listAllIntegrationAccounts(),
  hostForSession: defaultHostForSession,
  resolveToken: defaultResolveToken,
}

function rank(account: IntegrationAccount, owner: string): number {
  if (account.providerId === "github-app") {
    return account.label.trim().toLowerCase() === owner ? 0 : 2
  }
  return 1
}

/**
 * The integration accounts that may read `repoFullName` on `host`, best first.
 * Exported for the co-located test and for callers that report *which*
 * account a read will use.
 */
export async function githubReadAccountsFor(
  repoFullName: string,
  host: GithubHost = GITHUB_DOT_COM,
  deps: Pick<GithubReadCredentialDeps, "listAccounts" | "hostForSession"> = DEFAULT_DEPS
): Promise<IntegrationAccount[]> {
  const owner = repoFullName.split("/")[0]?.trim().toLowerCase() ?? ""
  const accounts = await deps.listAccounts().catch(() => [] as IntegrationAccount[])
  const eligible: IntegrationAccount[] = []
  for (const account of accounts) {
    if (!GITHUB_PROVIDER_IDS.has(account.providerId)) continue
    if (!account.enabled || account.health === "revoked") continue
    const accountHost = await deps.hostForSession(account.authSessionId).catch(() => undefined)
    // An account whose session cannot be read is not "github.com by default":
    // guessing the host is how a token reaches the wrong server.
    if (!accountHost || accountHost.id !== host.id) continue
    eligible.push(account)
  }
  // Stable: `listAllIntegrationAccounts` is newest-first, and within a rank
  // the most recently configured account stays ahead.
  return eligible
    .map((account, index) => ({ account, index, rank: rank(account, owner) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.account)
}

/**
 * A token for reading `repoFullName` on `host` from a connected account, or
 * null when no connected account can supply one. Never throws.
 */
export async function resolveGithubReadToken(
  repoFullName: string,
  host: GithubHost = GITHUB_DOT_COM,
  deps: GithubReadCredentialDeps = DEFAULT_DEPS
): Promise<string | null> {
  const accounts = await githubReadAccountsFor(repoFullName, host, deps)
  for (const account of accounts) {
    const token = await deps.resolveToken(account, host).catch(() => null)
    if (token) return token
  }
  return null
}
