/**
 * Where a Bot control write executes.
 *
 * The same three-way answer the Inbox relay uses, from the same shared
 * ordering in `lib/runtime/write-plane-route.ts`, with one substitution: the
 * local executor here is the DELIVERY RUNNER, not the connector runtime.
 *
 * The local predicate is deliberately not `hasCapability("always-on")`.
 * `always-on` is a static baseline that a desktop driving a remote Cognia
 * still reports, and the runner on such a desktop is stopped. Asking whether a
 * runner is actually running in THIS process is the honest question, and it is
 * the one `isBotRunnerOwnedHere` answers. The distinction is not academic: a
 * write routed local on a shell with no runner lands in a queue nothing drains.
 *
 * ## What each command needs
 *
 * `bot_trigger_set_armed` writes `botInstallations.triggerOverrides`, which is
 * configuration read by whichever runner picks the next delivery up. It does
 * NOT need a runner in this process, so it takes the `local` route on any
 * shell that owns the database. That is why {@link resolveBotWriteRoute} takes
 * the command: refusing to arm a trigger on a host that happens to be between
 * runners would be wrong.
 *
 * `bot_run_manual` and `bot_delivery_replay` write `botEventDeliveries`, and a
 * delivery only ever moves because a runner drains it. Those two ask for the
 * runner.
 */

import { hasCapability } from "@/lib/platform/capabilities"
import { isBotRunnerOwnedHere } from "@/lib/bot/runtime/runner-owner"
import type { HostFeatureManifest } from "@/lib/platform/host-feature-manifest"
import { supportsHostFeatureOperation } from "@/lib/platform/host-feature-manifest"
import {
  resolveOperationAvailability,
  type OperationAvailability,
} from "@/lib/runtime/operation-availability"
import { getRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { resolveWritePlaneRoute, type WritePlaneRoute } from "@/lib/runtime/write-plane-route"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { activeHostFeatureManifest } from "@/stores/remote-host/remote-host-store"

export type BotWriteRoute = WritePlaneRoute

/** The RPC each relayed write travels as. A local write never leaves the process. */
export const BOT_WRITE_COMMANDS = Object.freeze({
  setTriggerArmed: "bot_trigger_set_armed",
  runManual: "bot_run_manual",
  replayDelivery: "bot_delivery_replay",
} as const)

export type BotWriteCommand = (typeof BOT_WRITE_COMMANDS)[keyof typeof BOT_WRITE_COMMANDS]

/** Host feature that groups the relayed Bot control operations. */
export const BOT_CONTROL_FEATURE = "bots.control" as const

/**
 * Commands that need a delivery runner in THIS process, not merely a database.
 *
 * A set over the command names rather than a boolean at each call site, so
 * adding a fourth command has to decide which half it is in.
 */
const NEEDS_RUNNER: ReadonlySet<BotWriteCommand> = new Set([
  BOT_WRITE_COMMANDS.runManual,
  BOT_WRITE_COMMANDS.replayDelivery,
])

export interface BotWriteRouteDeps {
  isRemoteHostActive: () => boolean
  /** Does a delivery runner belong to this process right now? */
  isRunnerOwnedHere: () => boolean
  /** Does this shell own the account database at all? */
  hasLocalDatabase: () => boolean
  getRuntimeSnapshot: typeof getRuntimeSnapshot
  activeHostFeatureManifest: () => HostFeatureManifest | null
}

const defaultDeps: BotWriteRouteDeps = {
  isRemoteHostActive,
  isRunnerOwnedHere: isBotRunnerOwnedHere,
  // `always-on` is the right question HERE and the wrong one for the runner:
  // it asks whether this shell hosts the account's own database and long-lived
  // work at all, which is what a configuration write needs.
  hasLocalDatabase: () => hasCapability("always-on"),
  getRuntimeSnapshot,
  activeHostFeatureManifest,
}

let deps: BotWriteRouteDeps = defaultDeps

/** Test seam. Returns a restore function. */
export function __setBotWriteRouteDepsForTests(next: Partial<BotWriteRouteDeps>): () => void {
  const previous = deps
  deps = { ...deps, ...next }
  return () => {
    deps = previous
  }
}

export function resolveBotWriteRoute(command: BotWriteCommand): BotWriteRoute {
  return resolveWritePlaneRoute({
    isRemoteHostActive: deps.isRemoteHostActive,
    hasLocalExecutor: () =>
      NEEDS_RUNNER.has(command) ? deps.isRunnerOwnedHere() : deps.hasLocalDatabase(),
    targetKind: () => deps.getRuntimeSnapshot().target?.kind,
  })
}

/** Availability of ONE control command on the current route. */
export function resolveBotWriteAvailability(command: BotWriteCommand): OperationAvailability {
  const route = resolveBotWriteRoute(command)
  if (route === "local") return { state: "available", reason: "local-host" }
  if (route === "unavailable") {
    // Two different refusals. A shell that owns the database but has no runner
    // is waiting on one. A shell with neither cannot act at all, and its way
    // out is to pair with a Host.
    return NEEDS_RUNNER.has(command) && deps.hasLocalDatabase()
      ? { state: "unsupported", reason: "operation-unavailable" }
      : { state: "unsupported", reason: "requires-companion" }
  }
  if (deps.isRemoteHostActive()) {
    const manifest = deps.activeHostFeatureManifest()
    if (!manifest) return { state: "incompatible", reason: "host-manifest-missing" }
    return supportsHostFeatureOperation(manifest, BOT_CONTROL_FEATURE, command)
      ? { state: "available", reason: "local-host" }
      : { state: "unsupported", reason: "operation-unavailable" }
  }
  return resolveOperationAvailability({
    snapshot: deps.getRuntimeSnapshot(),
    command,
    localExecutorAvailable: false,
    readOnlyFallback: false,
    // Every relayed control write is idempotent by contract, so the durable
    // queue may hold one until the connection returns.
    offlineQueueAllowed: true,
  })
}

/** Availability states under which a relayed write may be enqueued. */
const ENQUEUEABLE_STATES: ReadonlySet<OperationAvailability["state"]> = new Set([
  "available",
  "queued",
  "offline",
])

export function canEnqueueBotWrite(availability: OperationAvailability): boolean {
  return ENQUEUEABLE_STATES.has(availability.state)
}
