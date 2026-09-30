/**
 * The bridge caller id: who is on the other end of an MCP call.
 *
 * The Rust HTTP proxy stamps the authenticated client credential id into
 * `params._meta.cogniaBridgeClientId`; stdio calls carry none. Everything
 * keyed per client — the browser session, the job owner session, workspace
 * grants — derives from this one normalization, so the Settings grant picker
 * and the server can never disagree about a client's key.
 *
 * Pure on purpose: the MCP sidecar bundle imports it.
 */

/** Caller id of the stdio transport (no client credential). */
export const STDIO_BRIDGE_CALLER = "mcp:stdio"

export function bridgeCallerForClientId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return STDIO_BRIDGE_CALLER
  const normalized = raw
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, "_")
    .slice(0, 128)
  return `mcp:${normalized || "client"}`
}
