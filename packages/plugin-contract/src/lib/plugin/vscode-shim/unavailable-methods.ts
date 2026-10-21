/**
 * Leaf module: no imports, so the plugin SDK's `contracts` subpath can publish
 * this list without pulling the handler graph into an author's bundle.
 */

/**
 * Outbound requests/notifications the sidecar may send that have no renderer
 * handler yet. Registering these is intentional: requests receive a
 * deterministic JSON-RPC capability error immediately and notifications are
 * logged by the dispatcher rather than disappearing as "method not found"
 * noise.
 *
 * Empty while every method the host sends is backed. A method belongs here
 * when the host gains it before the renderer does.
 */
export const EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS: readonly string[] = []
