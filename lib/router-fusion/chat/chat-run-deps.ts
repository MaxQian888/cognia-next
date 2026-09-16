/**
 * The dependencies every chat run of this window uses (ADR-0188): the current
 * account's fusion store, the account-database outbox appliers, and one lease
 * owner per page load — a reloaded window is a different worker, so a run it
 * left behind is recognised as abandoned once its lease lapses.
 */

import { accountDatabaseAppliers } from "../db/outbox-appliers"
import type { RouterFusionInfrastructureError } from "../gate/faults"
import type { ChatRunDeps } from "./chat-runs"
import { currentFusionStore } from "./store-provider"

const WINDOW_LEASE_OWNER = `window:${globalThis.crypto.randomUUID()}`

export function windowLeaseOwner(): string {
  return WINDOW_LEASE_OWNER
}

export function chatRunDeps(
  onFault: (fault: RouterFusionInfrastructureError) => void
): ChatRunDeps {
  return {
    store: () => currentFusionStore(),
    appliers: accountDatabaseAppliers,
    leaseOwner: WINDOW_LEASE_OWNER,
    onFault,
  }
}
