/**
 * Repository webhooks for GitHub personal-access-token accounts.
 *
 * A GitHub App has one webhook, configured through `PATCH /app/hook/config`
 * (`github-webhook.ts`). A PAT has no App, so its events arrive only through a
 * per-repository hook (`/repos/{owner}/{repo}/hooks`). Without this module a PAT
 * user had to find the ingress URL and secret in the hub and paste them into
 * each repository's settings page by hand, with nothing in the app saying so.
 *
 * One ingress endpoint, one secret, per account: every repository hook of the
 * account signs with the same secret, so this reads the endpoint's current
 * secret rather than minting a new one. Rotating it here would silently break
 * every other repository already delivering to the endpoint.
 *
 * The request is host-owned and does not go through the plugin PII gate: its
 * body is the user's own webhook secret going to the user's own GitHub, which
 * the gate would (correctly, for plugin traffic) refuse as a secret.
 */

import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { updateIntegrationAccount } from "@/lib/db/integrations"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { getProvider } from "@/lib/plugin/auth/auth-provider-registry"
import { integrationApiBaseUrl } from "./action-runner"
import { isPubliclyDeliverableUrl } from "./webhook-url"

/** Event families a repository hook can carry; App lifecycle events are not among them. */
const APP_ONLY_EVENT_PREFIXES = ["installation", "github_app_authorization"]

interface RepoHook {
  id: number
  events?: string[]
  config?: { url?: string }
}

export interface GithubRepoWebhookDeps {
  request<T>(
    account: IntegrationAccount,
    path: string,
    init?: { method?: string; body?: Record<string, unknown> }
  ): Promise<{ status: number; data: T }>
  loadSecret(handle: string): Promise<string | null>
  updateAccount: typeof updateIntegrationAccount
  now(): number
}

async function hostRequest<T>(
  account: IntegrationAccount,
  path: string,
  init: { method?: string; body?: Record<string, unknown> } = {}
): Promise<{ status: number; data: T }> {
  const provider = getProvider(account.providerId)
  if (!provider?.resolveRequestCredential) {
    throw new Error(`Auth provider "${account.providerId}" cannot resolve a credential`)
  }
  const base = (await integrationApiBaseUrl(account)) ?? "https://api.github.com"
  const credential = await provider.resolveRequestCredential(account.authSessionId, {
    accountId: account.id,
    origin: new URL(base).origin,
  })
  const response = await proxyFetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${credential.accessToken}`,
      "x-github-api-version": "2022-11-28",
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  const contentType = response.headers.get("content-type") ?? ""
  const data = contentType.includes("application/json")
    ? ((await response.json()) as T)
    : ((await response.text()) as T)
  return { status: response.status, data }
}

function defaultDeps(): GithubRepoWebhookDeps {
  const store = createKeyringStore("integration-ingress")
  return {
    request: hostRequest,
    loadSecret: (handle) => store.load(handle),
    updateAccount: updateIntegrationAccount,
    now: Date.now,
  }
}

/**
 * The GitHub webhook event names for a subscription's event types:
 * `issues.closed` → `issues`, `push.received` → `push`. App lifecycle events
 * are dropped, a repository hook cannot subscribe to them.
 */
export function repoHookEvents(eventTypes: readonly string[]): string[] {
  const names = eventTypes
    .map((eventType) => eventType.split(".")[0] ?? "")
    .filter((name) => name && !APP_ONLY_EVENT_PREFIXES.some((prefix) => name.startsWith(prefix)))
  return [...new Set(names)].sort()
}

/** Why a repository hook could not be configured, as a code the UI can translate. */
export class GithubRepoWebhookError extends Error {
  readonly code: "not-pat" | "not-public" | "no-endpoint" | "no-secret" | "forbidden" | "failed"

  constructor(code: GithubRepoWebhookError["code"], message: string) {
    super(message)
    this.name = "GithubRepoWebhookError"
    this.code = code
    Object.setPrototypeOf(this, GithubRepoWebhookError.prototype)
  }
}

export interface ConfigureGithubRepoWebhookInput {
  account: IntegrationAccount
  repoFullName: string
  /** The PUBLIC delivery URL — never the loopback listener address. */
  webhookUrl: string
  /** Subscription event types; merged with whatever the hook already carries. */
  eventTypes: readonly string[]
}

export type ConfigureGithubRepoWebhookResult =
  | { status: "created" | "updated"; hookId: number; events: string[] }
  | { status: "skipped"; reason: "no-repository-events" }

/**
 * Create or update the repository hook that delivers to `webhookUrl`.
 * Idempotent: an existing hook for the same URL is updated in place, and its
 * events are unioned with the new ones so a second subscription on the same
 * repository does not unsubscribe the first.
 */
export async function configureGithubRepoWebhook(
  input: ConfigureGithubRepoWebhookInput,
  provided?: GithubRepoWebhookDeps
): Promise<ConfigureGithubRepoWebhookResult> {
  const { account, repoFullName, webhookUrl } = input
  if (
    account.pluginId !== "github-delivery" ||
    account.integrationId !== "github" ||
    account.providerId !== "github-pat"
  ) {
    // An App account already receives every repository's events through its
    // App hook; a repository hook on top would deliver each event twice.
    throw new GithubRepoWebhookError("not-pat", "Repository webhooks are for PAT accounts")
  }
  if (!isPubliclyDeliverableUrl(webhookUrl)) {
    throw new GithubRepoWebhookError(
      "not-public",
      "GitHub can only deliver to a public https URL; the local listener is not reachable"
    )
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
    throw new GithubRepoWebhookError("failed", `Not an "owner/repository" name: ${repoFullName}`)
  }
  const endpoint = account.ingressEndpoint
  if (!endpoint) {
    throw new GithubRepoWebhookError("no-endpoint", "The account has no webhook endpoint yet")
  }
  const wanted = repoHookEvents(input.eventTypes)
  if (wanted.length === 0) return { status: "skipped", reason: "no-repository-events" }

  const deps = provided ?? defaultDeps()
  const secret = await deps.loadSecret(endpoint.secretHandle)
  if (!secret) {
    throw new GithubRepoWebhookError("no-secret", "The webhook secret is missing from the keyring")
  }

  const hooksPath = `/repos/${repoFullName}/hooks`
  let existing: RepoHook | undefined
  for (let page = 1; page <= 10 && !existing; page += 1) {
    const listed = await deps.request<RepoHook[]>(account, `${hooksPath}?per_page=100&page=${page}`)
    if (listed.status === 403 || listed.status === 404) {
      throw new GithubRepoWebhookError(
        "forbidden",
        `The token cannot manage webhooks on ${repoFullName} (status ${listed.status})`
      )
    }
    if (listed.status < 200 || listed.status >= 300 || !Array.isArray(listed.data)) {
      throw new GithubRepoWebhookError("failed", `Listing webhooks failed (${listed.status})`)
    }
    existing = listed.data.find((hook) => hook.config?.url === webhookUrl)
    if (listed.data.length < 100) break
  }

  const events = [...new Set([...(existing?.events ?? []), ...wanted])].sort()
  const config = { url: webhookUrl, content_type: "json", insecure_ssl: "0", secret }
  const response = existing
    ? await deps.request<RepoHook>(account, `${hooksPath}/${existing.id}`, {
        method: "PATCH",
        body: { active: true, events, config },
      })
    : await deps.request<RepoHook>(account, hooksPath, {
        method: "POST",
        body: { name: "web", active: true, events, config },
      })
  if (response.status === 403 || response.status === 404) {
    throw new GithubRepoWebhookError(
      "forbidden",
      `The token cannot manage webhooks on ${repoFullName} (status ${response.status})`
    )
  }
  if (response.status < 200 || response.status >= 300) {
    throw new GithubRepoWebhookError(
      "failed",
      `Configuring the webhook failed (${response.status})`
    )
  }

  const checkedAt = new Date(deps.now()).toISOString()
  await deps.updateAccount(account.pluginId, account.id, {
    status: {
      ...(account.status ?? { health: account.health, checkedAt }),
      code: "webhook_verified",
      message: undefined,
      checkedAt,
    },
  })
  return {
    status: existing ? "updated" : "created",
    hookId: existing?.id ?? response.data.id,
    events,
  }
}
