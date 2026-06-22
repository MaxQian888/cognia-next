/**
 * Plugin SDK — `auth-provider` capability surface.
 *
 * Re-exports the provider authoring helper, native authentication registry,
 * and PKCE helper used by plugins that provide or consume auth sessions.
 */

export { defineAuthProvider } from "../define/define-auth-provider"

export {
  registerAuthenticationProvider,
  unregisterAuthenticationProvider,
  unregisterProvidersByPlugin,
  listProviders,
  getProvider,
  getSession,
  removeSession,
  onDidChangeSessions,
  hydrateFromSecrets,
  __makeSession,
} from "@/lib/plugin/auth/auth-provider-registry"
export { runPkceAuthFlow } from "@/lib/plugin/auth/auth-pkce-flow"

export type {
  AuthSession,
  AuthSessionChangeEvent,
  AuthSessionOptions,
  AuthenticationProvider,
} from "@/lib/plugin/auth/auth-provider-registry"
export type { PkceFlowConfig, PkceTokenResult } from "@/lib/plugin/auth/auth-pkce-flow"
export type {
  CreateAuthAPIOptions,
  PluginAuthAPI,
  PluginAuthProvider,
} from "@/lib/plugin/api/auth-api"
export type { PluginAuthProviderDef } from "@/types/plugin/plugin-auth"
