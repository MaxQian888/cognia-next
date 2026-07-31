/**
 * `ctx.auth` — native auth/OAuth provider API (C1).
 *
 * Promotes the previously VS-Code-only `auth-provider-registry` into a
 * first-class native plugin surface: a plugin can REGISTER an authentication
 * provider (`auth:provide`) and CONSUME sessions from any provider
 * (`auth:consume`), with tokens persisted via `ctx.secrets`. A PKCE helper
 * (`createPkceFlow`) wraps the reusable OAuth flow so a provider's
 * `createSession` doesn't hand-roll crypto. Like VS Code `authentication` +
 * Raycast OAuth / `withAccessToken`.
 */

import {
  registerAuthenticationProvider,
  getSession as registryGetSession,
  getProvider,
  onDidChangeSessions as registryOnDidChange,
  type AuthSession,
  type AuthSessionOptions,
  type AuthSessionChangeEvent,
} from "@/lib/plugin/auth/auth-provider-registry"
import {
  runPkceAuthFlow,
  type PkceFlowConfig,
  type PkceTokenResult,
} from "@/lib/plugin/auth/auth-pkce-flow"

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

function requirePermission(
  hasPermission: (p: string) => boolean,
  permission: string,
  method: string
): void {
  if (!hasPermission(permission)) {
    throw new Error(
      `${method} requires the "${permission}" permission — declare it in the plugin manifest.`
    )
  }
}

export function createAuthAPI(pluginId: string, options: CreateAuthAPIOptions): PluginAuthAPI {
  const { hasPermission } = options
  return {
    registerProvider(provider) {
      requirePermission(hasPermission, "auth:provide", "ctx.auth.registerProvider")
      return registerAuthenticationProvider({ ...provider, pluginId })
    },
    async getSession(providerId, scopes, sessionOptions) {
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSession")
      return registryGetSession(providerId, scopes, sessionOptions)
    },
    async getSessions(providerId, scopes) {
      requirePermission(hasPermission, "auth:consume", "ctx.auth.getSessions")
      const provider = getProvider(providerId)
      if (!provider) throw new Error(`No auth provider registered for id "${providerId}"`)
      return provider.getSessions(scopes, { silent: true })
    },
    onDidChangeSessions(listener) {
      return registryOnDidChange(listener)
    },
    async createPkceFlow(config) {
      requirePermission(hasPermission, "auth:provide", "ctx.auth.createPkceFlow")
      return runPkceAuthFlow(config)
    },
  }
}
