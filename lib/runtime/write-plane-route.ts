/**
 * Where a write executes: here, on a paired host, or nowhere.
 *
 * Extracted from `lib/connectors/inbox-writes/route.ts` when the Bot control
 * plane needed the same three-way answer. What is worth sharing is not the
 * three names, which are obvious, but the ORDER, which is not:
 *
 *   1. driving a remote host  -> remote
 *   2. this process has the executor -> local
 *   3. a companion target is active -> remote
 *   4. otherwise -> unavailable
 *
 * Step 1 has to come first. Every "does this shell have the executor"
 * capability in this app is a STATIC baseline (`lib/platform/capabilities.ts`),
 * so a Tauri desktop that is currently driving a remote Cognia still reports
 * `connector-runtime` and `always-on` even though its local runtimes are torn
 * down while the remote is active. Asking the capability first routes that
 * shell's writes into a process that will not execute them, and the row lands
 * in a queue nothing drains. It is the same trap `BotRuntimeInitializer` and
 * `resolveBotRuntimeReach` are ordered around.
 *
 * Step 3 is last because it is the weakest evidence: it says a target exists,
 * not that it can do this particular thing. Whether the paired host actually
 * implements the command is a separate question each caller asks against the
 * host feature manifest.
 */

export type WritePlaneRoute = "local" | "remote" | "unavailable"

export interface WritePlaneRouteInput {
  /** Is this process currently driving a remote host? */
  isRemoteHostActive: () => boolean
  /**
   * Does THIS process own the executor for this write, right now? A static
   * capability alone is not enough. See the ordering note above.
   */
  hasLocalExecutor: () => boolean
  /** Kind of the negotiated runtime target, from the runtime snapshot. */
  targetKind: () => string | undefined
}

export function resolveWritePlaneRoute(input: WritePlaneRouteInput): WritePlaneRoute {
  if (input.isRemoteHostActive()) return "remote"
  if (input.hasLocalExecutor()) return "local"
  return input.targetKind() === "companion" ? "remote" : "unavailable"
}
