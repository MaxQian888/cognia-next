/**
 * The plugin contract's share of `lib/plugin/api/auth-api.ts`, which re-exports these.
 */
import type {
  AuthSession,
  AuthSessionChangeEvent,
  AuthSessionOptions,
} from "../auth/auth-provider-registry"
import type { PkceFlowConfig, PkceTokenResult } from "../auth/auth-pkce-flow"

/** Provider object a plugin registers via `ctx.auth.registerProvider`. */
export interface PluginAuthProvider {
  id: string
  label: string
  getSessions(
    scopes: readonly string[] | undefined,
    options: AuthSessionOptions
  ): Promise<AuthSession[]>
  createSession(scopes: readonly string[]): Promise<AuthSession>
  removeSession(sessionId: string): Promise<void>
}

export interface PluginAuthAPI {
  /** Register an authentication provider (`auth:provide`). Returns a disposer. */
  registerProvider(provider: PluginAuthProvider): () => void
  /** Get (or interactively create) a session for a provider (`auth:consume`). */
  getSession(
    providerId: string,
    scopes: readonly string[],
    options?: AuthSessionOptions
  ): Promise<AuthSession | undefined>
  /** List existing sessions for a provider, silent (`auth:consume`). */
  getSessions(providerId: string, scopes?: readonly string[]): Promise<AuthSession[]>
  /** Observe session add/remove/change across all providers. */
  onDidChangeSessions(listener: (event: AuthSessionChangeEvent) => void): () => void
  /** Run an OAuth 2.0 + PKCE flow (`auth:provide`). Returns the raw tokens. */
  createPkceFlow(config: PkceFlowConfig): Promise<PkceTokenResult>
}

export interface CreateAuthAPIOptions {
  hasPermission: (permission: string) => boolean
}
