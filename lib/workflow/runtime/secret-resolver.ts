/**
 * Secret resolver — converts a credential ref id to its keychain value.
 *
 * In Tauri builds the resolver delegates to the existing keychain Tauri
 * commands; in web mode it falls back to the per-browser store. Phase 4
 * ships a stub that returns `undefined` for any ref — the AI/HTTP nodes
 * that need real keys will pull through the existing `lib/ai` provider
 * routing, which already handles credentials. A first-class secret-bag
 * with explicit refs lands when the workflow editor's "Credentials" UI
 * is built (Phase 9 polish).
 */

export interface SecretResolver {
  resolve(refId: string): Promise<string | undefined>
}

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
