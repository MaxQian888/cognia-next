/**
 * Host errors that callers match on, split out of `host.ts`.
 *
 * `host.ts` spawns the agent binary and therefore imports `node:child_process`
 * and friends. Re-exporting this class from there would drag that whole graph
 * into any bundle that merely wants to `instanceof`-check the error — including
 * the browser bundle, which reaches the runtime over injected streams and never
 * spawns anything.
 */
export class HostNotFoundError extends Error {
  readonly code = "host_not_found"
  readonly searchedLocations: readonly string[]

  constructor(searchedLocations: readonly string[]) {
    super(`Cognia agent host not found; searched: ${searchedLocations.join(", ")}`)
    this.name = "HostNotFoundError"
    this.searchedLocations = searchedLocations
  }
}
