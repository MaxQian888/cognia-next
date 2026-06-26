// MCP protocol-version negotiation for the stand-alone a2ui MCP server
// (`sidecar/a2ui-mcp.mjs`). Per the MCP spec, on `initialize` the server must
// echo the client's requested `protocolVersion` when it supports it, otherwise
// answer with its own preferred supported version (the client then decides
// whether it can proceed). The old server hard-coded `2024-11-05` regardless of
// what the client asked for, so a newer client (Claude Code / Cursor / Codex)
// advertising a later revision got a mismatched answer.
//
// The server's surface (tools/list, tools/call, ping + a static `capabilities`
// object) is compatible across these base revisions, so feature-gating is done
// via `capabilities`, not the version string — making it safe to echo any
// recognised revision.

/** Base MCP revisions whose envelope this server is compatible with. */
export const A2UI_MCP_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"]

/** Version answered when the client requests one we don't recognise / sends none. */
export const A2UI_MCP_PREFERRED_PROTOCOL_VERSION = "2025-06-18"

/**
 * @param {unknown} clientVersion The `params.protocolVersion` from `initialize`.
 * @returns {string} The version to echo in the initialize result.
 */
export function negotiateProtocolVersion(clientVersion) {
  if (typeof clientVersion === "string" && A2UI_MCP_PROTOCOL_VERSIONS.includes(clientVersion)) {
    return clientVersion
  }
  return A2UI_MCP_PREFERRED_PROTOCOL_VERSION
}
