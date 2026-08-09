/**
 * Role selection for the multi-call `cognia-agent` binary.
 *
 * The packaged binary embeds Node and plays several roles, routed by the
 * `COGNIA_ROLE` env var:
 *   - `sidecar`     — the CLI self-execs this way to launch the sidecar host
 *                     (see `runtime/bootstrap.resolveSpawnTarget`);
 *   - `tool-bridge` — an EXTERNAL agent spawns it this way as the Cognia
 *                     tool-host MCP server, so Claude Code / Codex can call
 *                     Cognia's own tools (see `agent/tool-host/spawn.ts`);
 *   - `mcp-relay`   — the Agent SDK spawns a guarded remote MCP stdio relay;
 *   - otherwise     — the interactive/headless CLI agent.
 *
 * Kept as a pure function so `entry.ts` stays a thin wrapper.
 */

export type CliRole = "cli" | "sidecar" | "tool-bridge" | "mcp-relay"

/** Decide which role this process should run, from its environment. */
export function selectRole(env: Record<string, string | undefined>): CliRole {
  if (env.COGNIA_ROLE === "sidecar") return "sidecar"
  if (env.COGNIA_ROLE === "tool-bridge") return "tool-bridge"
  if (env.COGNIA_ROLE === "mcp-relay") return "mcp-relay"
  return "cli"
}
