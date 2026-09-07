/**
 * Who actually drains this account's Bot queue, as seen from this shell.
 *
 * The console has to answer it out loud. Every other question on the page is
 * about configuration, and configuration reads exactly the same whether or not
 * anything will ever act on it. A browser tab with no `always-on` shows armed
 * triggers, bound credentials and a healthy status for a Bot that will never
 * fire once, and there is nothing on screen to tell those two apart. That is
 * the failure this module exists to prevent.
 *
 * The predicate is the runner's own, not a paraphrase of it:
 * `BotRuntimeInitializer` starts when `hasCapability("always-on")` holds and no
 * remote host is active, so those are the two questions asked here in the same
 * order. Asking a different question is how a notice ends up disagreeing with
 * the runtime it describes.
 */

import { hasCapability, hasHostRuntime } from "@/lib/platform/capabilities"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"

export type BotRuntimeReach =
  /** This shell runs the delivery runner. Bots armed here fire here. */
  | "local"
  /**
   * This shell is driving a remote Host. That Host drains its own queue, and
   * this process deliberately does not: its rows are mirrors, and running one
   * would mint an `ExecutionRun` id the owning Host is already using.
   */
  | "remote"
  /**
   * A companion with a paired Host. The Host drains. Reads are honest here,
   * and a write has to be relayed rather than applied locally.
   */
  | "paired"
  /**
   * Nothing drains. A standalone browser tab has no long-lived runner and no
   * Host to ask, so an installation made here is configuration for a machine
   * that does not exist yet.
   */
  | "none"

export interface BotRuntimeReachDeps {
  hasAlwaysOn: () => boolean
  remoteActive: () => boolean
  hasHost: () => boolean
}

const DEFAULT_DEPS: BotRuntimeReachDeps = {
  hasAlwaysOn: () => hasCapability("always-on"),
  remoteActive: isRemoteHostActive,
  hasHost: () => hasHostRuntime(),
}

export function resolveBotRuntimeReach(deps: BotRuntimeReachDeps = DEFAULT_DEPS): BotRuntimeReach {
  // Ordered exactly like the initializer's gates. `always-on` is a STATIC
  // baseline, so a desktop that is currently driving a remote host still
  // reports it, and testing the capability first would call that shell local.
  if (deps.remoteActive()) return "remote"
  if (deps.hasAlwaysOn()) return "local"
  return deps.hasHost() ? "paired" : "none"
}

/** Will an armed trigger on this account fire at all, from anywhere? */
export function botRuntimeReachIsCovered(reach: BotRuntimeReach): boolean {
  return reach !== "none"
}
