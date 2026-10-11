/**
 * Reading an item's owner (ADR-0224 §Ownership).
 *
 * Every runtime that arms, fires or starts always-on work asks the same two
 * questions of the same field, so they are answered once here: does this
 * machine run the item, and may a write make it run here? The type and its
 * semantics are documented on `ItemOwner`.
 */

import type {
  ItemOwner,
  ItemOwnerRemoteHost,
  ItemOwnerThisDevice,
  OwnedItemKind,
} from "@/types/placement/item-owner"

import type { AuthorityDecision } from "./authority"

/** True when the item was moved to a paired host and this row is its placeholder. */
export function isOwnedElsewhere(
  owner: ItemOwner | undefined | null
): owner is ItemOwnerRemoteHost {
  return owner?.kind === "remote-host"
}

/** True when the item is pinned to this machine, whatever the global authority says. */
export function isPinnedHere(owner: ItemOwner | undefined | null): owner is ItemOwnerThisDevice {
  return owner?.kind === "this-device"
}

/**
 * Does this machine run the item at all?
 *
 * Bots and connectors have no global authority, so for them this is the
 * whole answer. The scheduler composes it with the global authority through
 * `resolveItemTimingAuthority`.
 */
export function runsHere(owner: ItemOwner | undefined | null): boolean {
  return !isOwnedElsewhere(owner)
}

/**
 * The timing decision for one scheduled item.
 *
 * The global authority predates per-item ownership and stays in charge of
 * exactly the items nobody pinned (ADR-0224). A pin overrides it in both
 * directions: a placeholder never fires here even when this machine is the
 * global authority, and an item pinned here fires even when it is not.
 */
export function resolveItemTimingAuthority(
  owner: ItemOwner | undefined | null,
  global: () => AuthorityDecision
): AuthorityDecision & { ownedElsewhere: boolean } {
  if (isOwnedElsewhere(owner)) {
    return {
      isAuthority: false,
      degraded: false,
      authorityHostId: owner.hostId,
      ownedElsewhere: true,
    }
  }
  if (isPinnedHere(owner)) {
    return { isAuthority: true, degraded: false, authorityHostId: null, ownedElsewhere: false }
  }
  return { ...global(), ownedElsewhere: false }
}

/**
 * A write that would make a placeholder run here.
 *
 * Re-enabling, resuming or running a moved item locally would put the same
 * work on two machines, which is the double fire ownership exists to prevent.
 * The way back is *take back*, which deletes the host's copy first.
 */
export class ItemOwnedElsewhereError extends Error {
  readonly code = "item_owned_elsewhere"
  readonly kind: OwnedItemKind
  readonly hostId: string
  readonly hostLabel: string

  constructor(kind: OwnedItemKind, owner: ItemOwnerRemoteHost) {
    super(
      `item_owned_elsewhere: this ${kind.replace("-", " ")} runs on ${owner.hostLabel}; take it back to run it here`
    )
    this.name = "ItemOwnedElsewhereError"
    this.kind = kind
    this.hostId = owner.hostId
    this.hostLabel = owner.hostLabel
  }
}

export function assertRunsHere(kind: OwnedItemKind, owner: ItemOwner | undefined | null): void {
  if (isOwnedElsewhere(owner)) throw new ItemOwnedElsewhereError(kind, owner)
}

export function isItemOwnedElsewhereError(error: unknown): error is ItemOwnedElsewhereError {
  return (
    error instanceof ItemOwnedElsewhereError ||
    (error instanceof Error && error.message.startsWith("item_owned_elsewhere:"))
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

/**
 * Validate an owner read from storage or the wire.
 *
 * A malformed owner is dropped rather than trusted: read as "nobody pinned
 * it", the item falls back to the pre-ADR-0224 behaviour, whereas a
 * half-parsed `remote-host` could strand it with no host to take it back from.
 */
export function parseItemOwner(value: unknown): ItemOwner | undefined {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (record.kind === "this-device") {
    if (record.reason !== "manual" && record.reason !== "machine-bound") return undefined
    if (!isTimestamp(record.pinnedAt)) return undefined
    return { kind: "this-device", reason: record.reason, pinnedAt: record.pinnedAt }
  }
  if (record.kind === "remote-host") {
    if (
      !isNonEmptyString(record.hostId) ||
      !isNonEmptyString(record.hostLabel) ||
      !isNonEmptyString(record.remoteItemId) ||
      !isNonEmptyString(record.operationId) ||
      !isTimestamp(record.movedAt)
    ) {
      return undefined
    }
    return {
      kind: "remote-host",
      hostId: record.hostId,
      hostLabel: record.hostLabel,
      remoteItemId: record.remoteItemId,
      operationId: record.operationId,
      movedAt: record.movedAt,
    }
  }
  return undefined
}

export function pinnedHere(
  reason: ItemOwnerThisDevice["reason"],
  now: number = Date.now()
): ItemOwnerThisDevice {
  return { kind: "this-device", reason, pinnedAt: now }
}
