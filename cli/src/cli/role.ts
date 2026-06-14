/**
 * Role selection for the multi-call `cognia-agent` binary.
 *
 * The packaged binary embeds Node and plays two roles, routed by the
 * `COGNIA_ROLE` env var: the default CLI agent, or — when the CLI self-execs to
 * launch the sidecar (see `runtime/bootstrap.resolveSpawnTarget`) — the sidecar
 * host. Kept as a pure function so `entry.ts` stays a thin wrapper.
 */

export type CliRole = "cli" | "sidecar"

/** Decide which role this process should run, from its environment. */
export function selectRole(env: NodeJS.ProcessEnv): CliRole {
  return env.COGNIA_ROLE === "sidecar" ? "sidecar" : "cli"
}
