/**
 * Who arms, fires and runs one piece of always-on work (ADR-0224 §Ownership).
 *
 * Scheduled tasks, bot installations and connector instances each carry one.
 * Before ADR-0224 nothing did: everything the desktop held ran on the desktop,
 * and the only placement knob was one global timing authority in
 * `localStorage` (`lib/placement/authority.ts`). That cannot express "this
 * digest runs on the Mac mini, that backup stays here".
 *
 * An owner is read by the database it is stored in. Each machine keeps its own
 * rows in phase A, so the field answers "does THIS machine run it?":
 *
 *   * **absent**: nobody pinned it. The scheduler defers to the global timing
 *     authority, exactly as before ADR-0224; bots and connectors run here.
 *   * **`this-device`**: pinned here. It runs on this machine even when the
 *     global authority names another host. Machine-bound items get this so a
 *     handed-off authority cannot silently strand them.
 *   * **`remote-host`**: moved to a paired host. The local row is a disabled
 *     placeholder kept so this machine can say where the item runs and take it
 *     back. Runtimes never arm, fire or start it.
 *
 * Phase B turns the pin into an ADR-0215 §8 lease preference without changing
 * this shape: `remote-host.hostId` becomes the preferred lease holder.
 */
export type ItemOwner = ItemOwnerThisDevice | ItemOwnerRemoteHost

export interface ItemOwnerThisDevice {
  kind: "this-device"
  /** Why it is pinned: the user chose it, or the classifier found it machine-bound. */
  reason: "manual" | "machine-bound"
  pinnedAt: number
}

export interface ItemOwnerRemoteHost {
  kind: "remote-host"
  /** `RemoteHost.id` in this device's registry (`stores/remote-host`). */
  hostId: string
  /**
   * The host's label when the item moved. Kept so a placeholder still names
   * where its item runs after the host was unpaired from this device.
   */
  hostLabel: string
  /** The item's id on the host, which take-back and status reads address. */
  remoteItemId: string
  /** The migration that moved it; replaying that operation is a no-op. */
  operationId: string
  movedAt: number
}

/** The three kinds of always-on work that carry an owner. */
export type OwnedItemKind = "scheduled-task" | "bot-installation" | "connector-instance"

/**
 * Where an item came from when it was not authored on this machine.
 *
 * Recorded by the host that receives it, so a row that arrived from a file or
 * from another device can say so, and a migration replayed after a dropped
 * connection finds the row it already created instead of making a second.
 */
export interface ItemProvenance {
  kind: "import" | "migration"
  /** Epoch ms it arrived. */
  at: number
  /** What it came from, as a person would name it: a file, or the device that moved it. */
  sourceLabel?: string
  /** The migration that created it. */
  operationId?: string
}
