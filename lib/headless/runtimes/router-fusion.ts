/**
 * Brain half of Router + Fusion (ADR-0188 D9/D36/D38/D39, B2).
 *
 * The brain answers the gateway's Run API, `cognia/*` and passthrough commands
 * whenever it is the connected brain. Those commands arrive over the companion
 * writes bridge and are dispatched by `lib/companion/desktop-write-source.ts`
 * (installed here by the `desktop-message-source` runtime) to
 * `gate/run-api-bridge.ts` and `gate/passthrough-bridge.ts`; on `cognia-server`
 * the gateway reaches them through `cognia_companion::gateway_brain`. What this
 * runtime adds is everything else the desktop's `RouterFusionInitializer` and
 * gateway provider do for their window:
 *
 *  - **The gateway switches.** A headless gateway's routing snapshot is
 *    projected from the Provider Profile Store, which knows nothing about
 *    Router + Fusion, so `/v1/runs` would stay `403` and passthrough
 *    `bypassed:surface_off` forever. The brain therefore publishes the
 *    account's two gateway switches (`gatewayRuns`, `gatewayPassthroughLedger`)
 *    to the server itself, whenever the settings row changes and again on a
 *    heartbeat, since a publish sent while the bridge is reconnecting is
 *    dropped. Like the desktop's snapshot, this is the switch, not the breaker:
 *    a tripped surface is answered by the gate here, so the caller learns why.
 *  - **Recovery.** Seal the runs a stopped brain left holding a hold or a lock,
 *    and resume the orchestrated cascade and panel runs whose surface is still
 *    on (B3) instead of sealing them.
 *  - **Retention.** Apply the fusion database's windows daily.
 *
 * All three read the account's settings row from the database rather than the
 * settings store, which a brain never loads — the same row
 * `gate/current-settings.ts` falls back to. Recovery and retention do nothing,
 * not even load Router + Fusion, while every wired surface is off.
 *
 * Breaker persistence stays window-only: it writes trips through the settings
 * store's save path, which is the window's. A trip recorded in the brain still
 * takes the surface out for the life of this process; it just does not
 * survive a restart.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import { effectiveSurface } from "@cognia/router-fusion/settings/switches"
import Dexie from "dexie"

import { registerHeadlessRuntime } from "../registry"
import type { HeadlessRuntimeContext } from "../types"

/**
 * The `respond` command the server applies the switches from. Mirrored by
 * `PUBLISH_SWITCHES_COMMAND` in `crates/cognia-companion/src/gateway_brain.rs`.
 */
export const GATEWAY_SWITCHES_PUBLISH_COMMAND = "gateway_router_fusion_switches_publish"

/**
 * How often the switches are published even when nothing changed. A publish
 * the bridge drops while it reconnects would otherwise leave a restarted
 * server's gateway off until the account next touched its settings.
 */
export const GATEWAY_SWITCHES_HEARTBEAT_MS = 60_000

/** The gateway's `RouterFusionGatewaySwitches`, as the server reads them. */
export interface GatewaySwitches {
  runsEnabled: boolean
  passthroughLedgerEnabled: boolean
}

/**
 * The two gateway surfaces, by the same check every other call site uses —
 * literally `true` for the master switch and for the surface — and the same
 * answer `routerFusionSwitchesOf` gives the desktop's snapshot.
 */
export function gatewaySwitchesOf(settings: AppSettings | null): GatewaySwitches {
  const switches = settings?.routerFusion as Parameters<typeof effectiveSurface>[0]
  return {
    runsEnabled: effectiveSurface(switches, "gatewayRuns"),
    passthroughLedgerEnabled: effectiveSurface(switches, "gatewayPassthroughLedger"),
  }
}

function startSwitchesPublisher(
  ctx: HeadlessRuntimeContext,
  readSettings: () => Promise<AppSettings | null>
): () => void {
  let last: string | null = null
  let current: GatewaySwitches = { runsEnabled: false, passthroughLedgerEnabled: false }
  let stopped = false

  const publish = (switches: GatewaySwitches, force: boolean) => {
    if (stopped) return
    const key = JSON.stringify(switches)
    const changed = key !== last
    current = switches
    if (!changed && !force) return
    last = key
    if (changed) {
      ctx.log(
        "info",
        `router-fusion gateway switches: runs=${switches.runsEnabled}, passthrough ledger=${switches.passthroughLedgerEnabled}`
      )
    }
    void Promise.resolve()
      .then(() => ctx.bridge.invoke(GATEWAY_SWITCHES_PUBLISH_COMMAND, { ...switches }))
      .catch((error: unknown) =>
        ctx.log("warn", `router-fusion could not publish gateway switches: ${String(error)}`)
      )
  }

  // `Dexie.liveQuery`, not a named `liveQuery` import: dexie's CJS build makes
  // `liveQuery` non-enumerable, so SWC's wildcard interop drops it the moment a
  // module also imports the `Dexie` default. See `lib/db/outbound-jobs.ts`.
  const subscription = Dexie.liveQuery(readSettings).subscribe({
    next: (settings) => publish(gatewaySwitchesOf(settings ?? null), false),
    error: (error: unknown) =>
      ctx.log("warn", `router-fusion settings watch failed: ${String(error)}`),
  })
  const heartbeat = setInterval(() => publish(current, true), GATEWAY_SWITCHES_HEARTBEAT_MS)
  // A heartbeat must not be what keeps a stopping brain alive.
  ;(heartbeat as { unref?: () => void }).unref?.()

  return () => {
    stopped = true
    clearInterval(heartbeat)
    subscription.unsubscribe()
  }
}

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
    const stopPublisher = startSwitchesPublisher(ctx, readSettings)
    // Recovery is one sweep at start. It is not awaited into the boot order:
    // a slow fusion database must not hold up the runtimes after this one.
    void readSettings()
      .then((settings) => recoverRouterFusionRuns(settings))
      .catch((error: unknown) => ctx.log("warn", `router-fusion recovery failed: ${String(error)}`))
    const stopRetention = startRouterFusionRetention(readSettings)
    return () => {
      stopPublisher()
      stopRetention()
    }
  },
})
