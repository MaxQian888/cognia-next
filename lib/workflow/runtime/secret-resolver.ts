import type { SecretResolver } from "@cognia/plugin-contract/lib/workflow/runtime/secret-resolver"
export type { SecretResolver } from "@cognia/plugin-contract/lib/workflow/runtime/secret-resolver"

/**
 * Default no-op resolver. Returns undefined for every ref. Node executors
 * that need credentials should fall back to existing app-level routing
 * (provider keys, OAuth tokens, etc.) rather than expecting refs to resolve.
 */
export const NoopSecretResolver: SecretResolver = {
  resolve: async () => undefined,
}

/**
 * In-memory resolver — useful for tests and for nodes that want to inject
 * dummy values without going through Dexie/keychain.
 */
export function createInMemoryResolver(map: Record<string, string>): SecretResolver {
  return {
    resolve: async (refId: string) => map[refId],
  }
}
