// Runtime tool-search (deferred-loading) policy — pure helpers.
//
// claude-agent-sdk `alwaysLoad` semantics: when tool search is enabled the
// bundled CLI defers MCP-server tools behind tool search, keeping only the
// servers/tools marked `alwaysLoad` resident in the prompt. cognia's
// `resolveSendOptions` decides the policy (from AppSettings / Character) and
// ships it on `SendOptions` as the sidecar-protocol fields `toolSearchEnabled`
// / `alwaysLoadServers` / `alwaysLoadTools`. These helpers translate that
// policy into per-server / per-tool `alwaysLoad` decisions.
//
// Extracted from `anthropic.mjs` so the decision logic is unit-testable
// without spawning a real `query()` (which needs the bundled CLI binary).

/**
 * Build a `serverAlwaysLoad(name)` predicate from a SendOptions blob.
 *
 * - Tool search OFF (default): EVERY server stays resident (`true`) so all
 *   tools are loaded up-front — reproduces the legacy behaviour even if the
 *   bundled CLI would otherwise auto-defer past its context threshold.
 * - Tool search ON: only servers named in `alwaysLoadServers` stay resident;
 *   the rest defer behind tool search (`false`).
 *
 * @param {Record<string, any>} sendOptions
 * @returns {(serverName: string) => boolean}
 */
export function makeServerAlwaysLoad(sendOptions) {
  const enabled = sendOptions?.toolSearchEnabled === true
  const names = new Set(
    Array.isArray(sendOptions?.alwaysLoadServers) ? sendOptions.alwaysLoadServers : []
  )
  return (serverName) => !enabled || names.has(serverName)
}

/**
 * The set of bare tool names to pin resident at per-tool granularity. Only
 * meaningful when tool search is enabled; when off, server-level always-load
 * already keeps everything resident.
 *
 * @param {Record<string, any>} sendOptions
 * @returns {Set<string>}
 */
export function alwaysLoadToolSet(sendOptions) {
  return new Set(Array.isArray(sendOptions?.alwaysLoadTools) ? sendOptions.alwaysLoadTools : [])
}

/**
 * Re-key a user `mcpServers` map, stamping `alwaysLoad: true` onto each server
 * config the policy says should stay resident. Non-object configs pass through
 * untouched. Returns a NEW map (does not mutate the input).
 *
 * @param {Record<string, unknown>} servers  name → server config
 * @param {(serverName: string) => boolean} serverAlwaysLoad
 * @returns {Record<string, unknown>}
 */
export function stampUserServersAlwaysLoad(servers, serverAlwaysLoad) {
  const out = {}
  for (const [name, cfg] of Object.entries(servers ?? {})) {
    out[name] =
      cfg && typeof cfg === "object"
        ? { ...cfg, ...(serverAlwaysLoad(name) ? { alwaysLoad: true } : {}) }
        : cfg
  }
  return out
}
