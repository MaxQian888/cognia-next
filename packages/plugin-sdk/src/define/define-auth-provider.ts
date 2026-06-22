/**
 * Plugin SDK helper for native auth/OAuth providers (C1).
 *
 * Pure typesafety pass-through for the provider object a plugin registers via
 * `ctx.auth.registerProvider(...)`. The matching `manifest.authProviders[]`
 * entry is just `{ id, label }` and needs no helper.
 *
 * Usage:
 *   ctx.auth.registerProvider(defineAuthProvider({
 *     id: "acme",
 *     label: "Acme",
 *     getSessions: async () => [],
 *     createSession: async (scopes) => {
 *       const tokens = await ctx.auth.createPkceFlow({ ... })
 *       return __makeSession({ accessToken: tokens.accessToken, account, scopes })
 *     },
 *     removeSession: async () => {},
 *   }))
 */

import type { PluginAuthProvider } from "@/lib/plugin/api/auth-api"

export function defineAuthProvider(provider: PluginAuthProvider): PluginAuthProvider {
  return provider
}
