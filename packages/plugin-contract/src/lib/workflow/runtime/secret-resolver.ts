/**
 * The plugin contract's share of `lib/workflow/runtime/secret-resolver.ts`, which re-exports these.
 */
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
