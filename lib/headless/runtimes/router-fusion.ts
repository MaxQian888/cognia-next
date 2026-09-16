/**
 * Brain half of Router + Fusion's boot work (ADR-0188 D38/D39, B2).
 *
 * Since B2 the brain hosts Router + Fusion runs of its own. It answers the
 * gateway's Run API and passthrough commands whenever it is the connected
 * brain, and it runs workflows whose `ai.prompt` nodes are ledgered under
 * `agentsWorkflows`. So the two jobs the desktop's `RouterFusionInitializer`
 * does for its window are needed here too:
 *
 *  - **Recovery.** Seal the runs a stopped brain left holding a hold or a lock,
 *    and resume the orchestrated cascade and panel runs whose surface is still
 *    on (B3) instead of sealing them.
 *  - **Retention.** Apply the fusion database's windows daily.
 *
 * Both read the account's settings row from the database rather than the
 * settings store, which a brain never loads, and both do nothing — not even
 * load Router + Fusion — while every wired surface is off.
 *
 * Breaker persistence stays window-only: it writes trips through the settings
 * store's save path, which is the window's. A trip recorded in the brain still
 * takes the surface out for the life of this process; it just does not
 * survive a restart.
 */

import { registerHeadlessRuntime } from "../registry"

registerHeadlessRuntime({
  name: "router-fusion",
  hosts: ["brain"],
  start: async (ctx) => {
    const [{ recoverRouterFusionRuns, startRouterFusionRetention }, { getSettings }] =
      await Promise.all([import("@/lib/router-fusion/gate/boot"), import("@/lib/db/settings")])
    const readSettings = () =>
      getSettings().catch((error: unknown) => {
        ctx.log("warn", `router-fusion could not read settings: ${String(error)}`)
        return null
      })
    // Recovery is one sweep at start. It is not awaited into the boot order:
    // a slow fusion database must not hold up the runtimes after this one.
    void readSettings()
      .then((settings) => recoverRouterFusionRuns(settings))
      .catch((error: unknown) => ctx.log("warn", `router-fusion recovery failed: ${String(error)}`))
    return startRouterFusionRetention(readSettings)
  },
})
