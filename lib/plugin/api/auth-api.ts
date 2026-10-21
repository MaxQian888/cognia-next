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
} from "@/lib/plugin/auth/auth-provider-registry"
import { runPkceAuthFlow } from "@/lib/plugin/auth/auth-pkce-flow"
import type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
} from "@cognia/plugin-contract/lib/plugin/api/auth-api"
export type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
  PluginAuthProvider,
} from "@cognia/plugin-contract/lib/plugin/api/auth-api"

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
