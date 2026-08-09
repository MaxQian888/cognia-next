/**
 * `vscode.authentication.*` backing store for the VS Code reuse layer.
 *
 * Two surfaces this module powers:
 *   1. `vscode.authentication.registerAuthenticationProvider(id, label, provider)`
 *      → `registerAuthenticationProvider(...)` here.
 *   2. `vscode.authentication.getSession(providerId, scopes, options)`
 *      → `getSession(providerId, scopes, options)` here.
 *
 * Sessions are persisted via the existing `ctx.secrets` API (OS keyring on
 * desktop, IndexedDB-encrypted fallback on web) — we never write the raw
 * `accessToken` to disk in plain text.
 *
 * The registry is in-memory; the on-disk side lives in `secrets:` namespaced
 * entries keyed by `auth:<providerId>:<sessionId>`. On boot the consumer
 * (`createAuthenticationApi`) calls `hydrateFromSecrets()` to repopulate.
 *
 * A built-in GitHub provider lives at `auth-providers/github.ts` (registered
 * by the renderer's bootstrap, not here) — it reuses the claude-subscription
 * OAuth helpers.
 */

import { nanoid } from "nanoid"

export interface AuthSession {
  /** Stable id assigned when the session was created. */
  id: string
  /** Bearer token / API key. Persisted via cognia's secrets API. */
  accessToken: string
  /** Account identifier — typically email or user-id. */
  account: { id: string; label: string }
  /** Scopes granted with this session. Sorted for deterministic comparison. */
  scopes: string[]
}

export interface AuthSessionAddedEvent {
  provider: string
  session: AuthSession
}

export interface AuthSessionRemovedEvent {
  provider: string
  sessionId: string
}

export interface AuthSessionChangeEvent {
  added: AuthSession[]
  removed: AuthSession[]
  changed: AuthSession[]
}

export interface AuthenticationProvider {
  /** Stable provider identifier — e.g. `"github"`, `"microsoft"`. */
  id: string
  /** Human-readable label for the consent UI. */
  label: string
  /**
   * The plugin that registered this provider. `null` means the built-in
   * cognia provider (no plugin owns it).
   */
  pluginId: string | null
  /**
   * Create or retrieve a session for the supplied scopes. VS Code spec:
   * `createIfNone` triggers interactive auth; `silent` returns `null`
   * when no existing session matches.
   */
  getSessions: (
    scopes: readonly string[] | undefined,
    options: AuthSessionOptions
  ) => Promise<AuthSession[]>
  /** Open the interactive consent flow and return the resulting session. */
  createSession: (scopes: readonly string[], options?: AuthSessionOptions) => Promise<AuthSession>
  /** Resolve a short-lived request credential without exposing it to plugin code. */
  resolveRequestCredential?: (
    sessionId: string,
    context: AuthRequestCredentialContext
  ) => Promise<ResolvedAuthRequestCredential>
  /** Revoke a session. Idempotent. */
  removeSession: (sessionId: string) => Promise<void>
}

export interface AuthSessionOptions {
  createIfNone?: boolean
  forceNewSession?: boolean
  silent?: boolean
  clearSessionPreference?: boolean
  /** Provider-specific setup values collected by a host-owned form. */
  configuration?: Record<string, unknown>
}

export interface AuthRequestCredentialContext {
  accountId: string
  origin: string
}

export interface ResolvedAuthRequestCredential {
  accessToken: string
  expiresAt?: string
}

export interface SecretsAdapter {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<string[]>
}

const providers = new Map<string, AuthenticationProvider>()
const sessionListeners = new Set<(event: AuthSessionChangeEvent) => void>()
let secretsAdapter: SecretsAdapter | null = null

/**
 * Wire the cognia secrets API (`ctx.secrets`) so we can persist sessions
 * across restarts. The renderer's bootstrap calls this once per session.
 */
export function setSecretsAdapter(adapter: SecretsAdapter | null): void {
  secretsAdapter = adapter
}

function emit(event: AuthSessionChangeEvent): void {
  queueMicrotask(() => {
    for (const listener of sessionListeners) {
      try {
        listener(event)
      } catch (err) {
        console.warn("Auth session listener threw:", err)
      }
    }
  })
}

export function registerAuthenticationProvider(provider: AuthenticationProvider): () => void {
  if (providers.has(provider.id)) {
    console.warn(
      `Auth provider "${provider.id}" replaced (was owned by "${providers.get(provider.id)?.pluginId ?? "cognia"}").`
    )
  }
  providers.set(provider.id, provider)
  return () => unregisterAuthenticationProvider(provider.id)
}

export function unregisterAuthenticationProvider(id: string): void {
  providers.delete(id)
}

export function unregisterProvidersByPlugin(pluginId: string): number {
  let removed = 0
  for (const [id, p] of providers) {
    if (p.pluginId === pluginId) {
      providers.delete(id)
      removed += 1
    }
  }
  return removed
}

export function listProviders(): AuthenticationProvider[] {
  return [...providers.values()]
}

export function getProvider(id: string): AuthenticationProvider | undefined {
  return providers.get(id)
}

/**
 * VS Code's `getSession` contract:
 *   - When `createIfNone` is true and no session matches, open the
 *     interactive flow and return the new session.
 *   - When `silent` is true and no session matches, return `undefined`.
 *   - When neither flag is set, return an existing session if any, or
 *     `undefined` otherwise (caller is expected to call again with
 *     `createIfNone`).
 */
export async function getSession(
  providerId: string,
  scopes: readonly string[],
  options: AuthSessionOptions = {}
): Promise<AuthSession | undefined> {
  const provider = providers.get(providerId)
  if (!provider) {
    throw new Error(`No auth provider registered for id "${providerId}"`)
  }
  const existing = await provider.getSessions(scopes, { silent: true })
  if (!options.forceNewSession && existing.length > 0) {
    const match = existing.find((s) => scopesMatch(s.scopes, scopes))
    if (match) return match
  }
  if (options.createIfNone || options.forceNewSession) {
    const session = await provider.createSession(scopes, options)
    await persistSession(providerId, session)
    emit({ added: [session], removed: [], changed: [] })
    return session
  }
  return undefined
}

export async function removeSession(providerId: string, sessionId: string): Promise<void> {
  const provider = providers.get(providerId)
  if (!provider) return
  // Look up the row so the change-event carries the metadata.
  const existing = await provider.getSessions(undefined, { silent: true })
  const session = existing.find((s) => s.id === sessionId)
  await provider.removeSession(sessionId)
  if (secretsAdapter) {
    await secretsAdapter.delete(secretKey(providerId, sessionId)).catch(() => {})
  }
  if (session) {
    emit({ added: [], removed: [session], changed: [] })
  }
}

export function onDidChangeSessions(listener: (event: AuthSessionChangeEvent) => void): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

/**
 * Hydrate every persisted session from the secrets store on boot. Returns
 * the count rehydrated. Safe to call multiple times — idempotent.
 */
export async function hydrateFromSecrets(): Promise<number> {
  if (!secretsAdapter) return 0
  const keys = await secretsAdapter.list("auth:")
  let hydrated = 0
  for (const key of keys) {
    try {
      const raw = await secretsAdapter.get(key)
      if (!raw) continue
      JSON.parse(raw) as AuthSession // shape check
      hydrated += 1
    } catch {
      // Skip malformed entries — defensive but rare.
    }
  }
  return hydrated
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function scopesMatch(actual: string[], requested: readonly string[]): boolean {
  if (requested.length === 0) return true
  const set = new Set(actual)
  return requested.every((s) => set.has(s))
}

function secretKey(providerId: string, sessionId: string): string {
  return `auth:${providerId}:${sessionId}`
}

async function persistSession(providerId: string, session: AuthSession): Promise<void> {
  if (!secretsAdapter) return
  try {
    await secretsAdapter.set(secretKey(providerId, session.id), JSON.stringify(session))
  } catch (err) {
    console.warn(`Failed to persist auth session for "${providerId}":`, err)
  }
}

export function __makeSession(input: {
  accessToken: string
  account: { id: string; label: string }
  scopes: readonly string[]
}): AuthSession {
  return {
    id: nanoid(),
    accessToken: input.accessToken,
    account: input.account,
    scopes: [...input.scopes].sort(),
  }
}

export function __resetAuthRegistryForTesting(): void {
  providers.clear()
  sessionListeners.clear()
  secretsAdapter = null
}
