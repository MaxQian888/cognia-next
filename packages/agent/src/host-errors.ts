/**
 * Host errors that callers match on, split out of `host.ts`.
 *
 * `host.ts` spawns the agent binary and therefore imports `node:child_process`
 * and friends. Re-exporting this class from there would drag that whole graph
 * into any bundle that merely wants to `instanceof`-check the error — including
 * the browser bundle, which reaches the runtime over injected streams and never
 * spawns anything.
 *
 * The class itself lives in `errors.ts` so there is exactly one identity for
 * `instanceof` to match, and so it inherits the shared `CogniaError` contract.
 */
export { HostNotFoundError } from "./errors"
