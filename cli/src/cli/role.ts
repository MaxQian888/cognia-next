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
 *   - `webclone`    — the sidecar isolates the web-clone engine in a child;
 *   - `run-code`    — the strict sandbox launcher self-execs the code worker;
 *   - otherwise     — the interactive/headless CLI agent.
 *
 * Kept as a pure function so `entry.ts` stays a thin wrapper.
 */

export type CliRole =
  | "cli"
  | "sidecar"
  | "tool-bridge"
  | "mcp-relay"
  | "webclone"
  | "run-code"
  | "claude-probe"
  | "codegraph-probe"

/** Decide which role this process should run, from its environment. */
export function selectRole(env: Record<string, string | undefined>): CliRole {
  if (env.COGNIA_ROLE === "sidecar") return "sidecar"
  if (env.COGNIA_ROLE === "tool-bridge") return "tool-bridge"
  if (env.COGNIA_ROLE === "mcp-relay") return "mcp-relay"
  if (env.COGNIA_ROLE === "webclone") return "webclone"
  if (env.COGNIA_ROLE === "run-code") return "run-code"
  if (env.COGNIA_ROLE === "claude-probe") return "claude-probe"
  if (env.COGNIA_ROLE === "codegraph-probe") return "codegraph-probe"
  return "cli"
}
