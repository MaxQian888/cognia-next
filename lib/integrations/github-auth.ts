import { getDb } from "@/lib/db/schema"
import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import {
  registerAuthenticationProvider,
  type AuthSession,
  type AuthSessionOptions,
} from "@/lib/plugin/auth/auth-provider-registry"

const APP_PROVIDER_ID = "github-app"
const PAT_PROVIDER_ID = "github-pat"
const APP_PREFIX = "app:"
const PAT_PREFIX = "pat:"
const TOKEN_REFRESH_SKEW_MS = 60_000

type GithubAppRequest = <T>(
  sessionId: string,
  path: string,
  init?: { method?: string; body?: Record<string, unknown> }
) => Promise<{ status: number; headers: Record<string, string>; data: T }>

let githubAppRequest: GithubAppRequest | undefined

export async function authenticatedGithubAppRequest<T>(
  sessionId: string,
  path: string,
  init?: { method?: string; body?: Record<string, unknown> }
): Promise<{ status: number; headers: Record<string, string>; data: T }> {
  if (!githubAppRequest) throw new Error("GitHub App authentication is not initialized")
  if (!path.startsWith("/app/")) throw new Error("GitHub App requests are limited to /app APIs")
  return githubAppRequest<T>(sessionId, path, init)
}

interface GithubAppMetadata {
  appId: number
  installationId: number
  privateKey: string
  accountLabel: string
  scopes: string[]
}

interface GithubPatMetadata {
  token: string
  accountLabel: string
  scopes: string[]
}

interface CachedInstallationToken {
  accessToken: string
  expiresAt: string
}

export interface GithubIntegrationSecretStore {
  save(key: string, value: string): Promise<void>
  load(key: string): Promise<string | null>
  delete(key: string): Promise<void>
}

export interface GithubIntegrationAuthDependencies {
  store?: GithubIntegrationSecretStore
  fetch?: typeof globalThis.fetch
  now?: () => number
  createAppJwt?: (appId: number, privateKey: string, now: number) => Promise<string>
  listAccountSessionIds?: (providerId: string) => Promise<string[]>
}

export interface GithubAppInstallationOption {
  id: string
  label: string
  avatarUrl?: string
}

export async function discoverGithubAppInstallations(
  values: Record<string, unknown>,
  dependencies: Pick<GithubIntegrationAuthDependencies, "fetch" | "now" | "createAppJwt"> = {}
): Promise<GithubAppInstallationOption[]> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const createAppJwt = dependencies.createAppJwt ?? createGithubAppJwt
  const appId = requiredPositiveInteger(values, "appId")
  const privateKey = requiredString(values, "privateKey")
  const jwt = await createAppJwt(appId, privateKey, now())
  const installations: GithubAppInstallationOption[] = []
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/app/installations?per_page=100&page=${page}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${jwt}`,
          "x-github-api-version": "2022-11-28",
        },
      }
    )
    if (!response.ok) {
      throw Object.assign(
        new Error(`GitHub App installation discovery failed with status ${response.status}`),
        {
          status: response.status,
          requestId: response.headers.get("x-github-request-id") ?? undefined,
          retryAfter: response.headers.get("retry-after") ?? undefined,
        }
      )
    }
    const pageItems = (await response.json()) as Array<{
      id?: number
      account?: { login?: string; avatar_url?: string }
    }>
    installations.push(
      ...pageItems.flatMap((installation) =>
        installation.id
          ? [
              {
                id: String(installation.id),
                label: installation.account?.login ?? String(installation.id),
                avatarUrl: installation.account?.avatar_url,
              },
            ]
          : []
      )
    )
    if (pageItems.length < 100) break
  }
  return installations
}

function asSecretStore(store: KeyringStore): GithubIntegrationSecretStore {
  return {
    save: (key, value) => store.save(key, value),
    load: (key) => store.load(key),
    delete: (key) => store.delete(key),
  }
}

function requiredString(configuration: Record<string, unknown>, key: string): string {
  const value = configuration[key]
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`GitHub authentication requires ${key}`)
  }
  return value.trim()
}

function requiredPositiveInteger(configuration: Record<string, unknown>, key: string): number {
  const raw = configuration[key]
  const value = typeof raw === "string" ? Number(raw) : raw
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`GitHub authentication requires a positive integer ${key}`)
  }
  return value
}

function base64Url(value: string | Uint8Array): string {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "")
}

export async function createGithubAppJwt(
  appId: number,
  privateKeyPem: string,
  now: number
): Promise<string> {
  const nowSeconds = Math.floor(now / 1000)
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = base64Url(
    JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: appId })
  )
  const signingInput = `${header}.${payload}`
  const der = Uint8Array.from(
    atob(privateKeyPem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/gu, "")),
    (character) => character.charCodeAt(0)
  )
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput)
  )
  return `${signingInput}.${base64Url(new Uint8Array(signature))}`
}

async function defaultListAccountSessionIds(providerId: string): Promise<string[]> {
  const accounts = await getDb()
    .integrationAccounts.where("providerId")
    .equals(providerId)
    .toArray()
  return [...new Set(accounts.map((account) => account.authSessionId))]
}

function session(id: string, accountId: string, label: string, scopes: string[]): AuthSession {
  return {
    id,
    accessToken: "host-resolved",
    account: { id: accountId, label },
    scopes: [...new Set(scopes)].sort(),
  }
}

function configuration(options?: AuthSessionOptions): Record<string, unknown> {
  if (!options?.configuration) {
    throw new Error("GitHub authentication requires host-owned setup configuration")
  }
  return options.configuration
}

export function registerGithubIntegrationAuthProviders(
  dependencies: GithubIntegrationAuthDependencies = {}
): () => void {
  const store =
    dependencies.store ?? asSecretStore(createKeyringStore("integration-github-credentials"))
  const fetchImpl = dependencies.fetch ?? globalThis.fetch
  const now = dependencies.now ?? Date.now
  const createAppJwt = dependencies.createAppJwt ?? createGithubAppJwt
  const listAccountSessionIds = dependencies.listAccountSessionIds ?? defaultListAccountSessionIds
  const knownAppSessions = new Set<string>()
  const knownPatSessions = new Set<string>()
  const tokenCache = new Map<string, CachedInstallationToken>()

  async function appMetadata(sessionId: string): Promise<GithubAppMetadata> {
    const raw = await store.load(`${APP_PREFIX}${sessionId}`)
    if (!raw) throw new Error(`GitHub App session "${sessionId}" is unavailable`)
    return JSON.parse(raw) as GithubAppMetadata
  }

  async function patMetadata(sessionId: string): Promise<GithubPatMetadata> {
    const raw = await store.load(`${PAT_PREFIX}${sessionId}`)
    if (!raw) throw new Error(`GitHub PAT session "${sessionId}" is unavailable`)
    return JSON.parse(raw) as GithubPatMetadata
  }

  async function registeredAppRequest<T>(
    sessionId: string,
    path: string,
    init: { method?: string; body?: Record<string, unknown> } = {}
  ): Promise<{ status: number; headers: Record<string, string>; data: T }> {
    const metadata = await appMetadata(sessionId)
    const jwt = await createAppJwt(metadata.appId, metadata.privateKey, now())
    const response = await fetchImpl(`https://api.github.com${path}`, {
      method: init.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "x-github-api-version": "2022-11-28",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    })
    const headers = Object.fromEntries(response.headers.entries())
    const contentType = response.headers.get("content-type") ?? ""
    const data = contentType.includes("application/json")
      ? ((await response.json()) as T)
      : ((await response.text()) as T)
    return { status: response.status, headers, data }
  }
  githubAppRequest = registeredAppRequest

  const disposeApp = registerAuthenticationProvider({
    id: APP_PROVIDER_ID,
    label: "GitHub App",
    pluginId: null,
    async getSessions() {
      const ids = new Set([...knownAppSessions, ...(await listAccountSessionIds(APP_PROVIDER_ID))])
      const sessions = await Promise.all(
        [...ids].map(async (id) => {
          const metadata = await appMetadata(id)
          return session(
            id,
            String(metadata.installationId),
            metadata.accountLabel,
            metadata.scopes
          )
        })
      )
      return sessions
    },
    async createSession(scopes, options) {
      const values = configuration(options)
      const metadata: GithubAppMetadata = {
        appId: requiredPositiveInteger(values, "appId"),
        installationId: requiredPositiveInteger(values, "installationId"),
        privateKey: requiredString(values, "privateKey"),
        accountLabel:
          typeof values.accountLabel === "string" && values.accountLabel.trim()
            ? values.accountLabel.trim()
            : `GitHub App ${String(values.installationId)}`,
        scopes: [...new Set(scopes)],
      }
      const id = crypto.randomUUID()
      await store.save(`${APP_PREFIX}${id}`, JSON.stringify(metadata))
      knownAppSessions.add(id)
      return session(id, String(metadata.installationId), metadata.accountLabel, metadata.scopes)
    },
    async removeSession(sessionId) {
      knownAppSessions.delete(sessionId)
      tokenCache.delete(sessionId)
      await store.delete(`${APP_PREFIX}${sessionId}`)
    },
    async resolveRequestCredential(sessionId) {
      const cached = tokenCache.get(sessionId)
      if (cached && Date.parse(cached.expiresAt) > now() + TOKEN_REFRESH_SKEW_MS) return cached
      const metadata = await appMetadata(sessionId)
      const jwt = await createAppJwt(metadata.appId, metadata.privateKey, now())
      const response = await fetchImpl(
        `https://api.github.com/app/installations/${metadata.installationId}/access_tokens`,
        {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "x-github-api-version": "2022-11-28",
          },
        }
      )
      if (!response.ok) {
        const error = Object.assign(
          new Error(`GitHub App token exchange failed with status ${response.status}`),
          {
            status: response.status,
            requestId: response.headers.get("x-github-request-id") ?? undefined,
            retryAfter: response.headers.get("retry-after") ?? undefined,
          }
        )
        throw error
      }
      const payload = (await response.json()) as { token?: string; expires_at?: string }
      if (!payload.token) throw new Error("GitHub App token response did not include a token")
      const resolved = {
        accessToken: payload.token,
        expiresAt: payload.expires_at ?? new Date(now() + 50 * 60_000).toISOString(),
      }
      tokenCache.set(sessionId, resolved)
      return resolved
    },
  })

  const disposePat = registerAuthenticationProvider({
    id: PAT_PROVIDER_ID,
    label: "GitHub personal access token",
    pluginId: null,
    async getSessions() {
      const ids = new Set([...knownPatSessions, ...(await listAccountSessionIds(PAT_PROVIDER_ID))])
      return Promise.all(
        [...ids].map(async (id) => {
          const metadata = await patMetadata(id)
          return session(id, metadata.accountLabel, metadata.accountLabel, metadata.scopes)
        })
      )
    },
    async createSession(scopes, options) {
      const values = configuration(options)
      const metadata: GithubPatMetadata = {
        token: requiredString(values, "token"),
        accountLabel: requiredString(values, "accountLabel"),
        scopes: [...new Set(scopes)],
      }
      const id = crypto.randomUUID()
      await store.save(`${PAT_PREFIX}${id}`, JSON.stringify(metadata))
      knownPatSessions.add(id)
      return session(id, metadata.accountLabel, metadata.accountLabel, metadata.scopes)
    },
    async removeSession(sessionId) {
      knownPatSessions.delete(sessionId)
      await store.delete(`${PAT_PREFIX}${sessionId}`)
    },
    async resolveRequestCredential(sessionId) {
      const metadata = await patMetadata(sessionId)
      return { accessToken: metadata.token }
    },
  })

  return () => {
    if (githubAppRequest === registeredAppRequest) githubAppRequest = undefined
    tokenCache.clear()
    disposePat()
    disposeApp()
  }
}
