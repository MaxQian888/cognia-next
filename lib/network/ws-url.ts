/**
 * Turn an HTTP base URL into its WebSocket equivalent.
 *
 * Split out because getting it wrong is silent in exactly the case that matters.
 * `baseUrl.replace(/^https?/, "wss")` looks right and rewrites BOTH schemes to
 * `wss:` — so a plaintext host reached over `http://127.0.0.1:27891` gets a TLS
 * handshake against a listener that speaks none. The RPC leg, which builds its
 * URLs separately, keeps working; only the event stream dies, which reads as
 * "connected but nothing ever arrives" rather than as a connection error.
 *
 * `http:` → `ws:` and `https:` → `wss:`, anchored and scheme-exact so a host
 * whose name happens to start with those letters is left alone.
 */
export function toWebSocketBase(baseUrl: string): string {
  return baseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")
}
