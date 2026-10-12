/**
 * Vocabulary of moving always-on work to a paired host (ADR-0224 §Moving an
 * item is a handoff, not a copy).
 *
 * A preflight answers, for one item and one host, everything that would stop
 * the move or change what it means, before anything is sent. Every blocker is
 * listed; none is skipped or folded into another. Notes are what the user
 * should know but that do not stop the move.
 */

import type { MachineBoundReason } from "@/lib/placement/machine-bound"
import type { OwnedItemKind } from "@/types/placement/item-owner"

export interface MigrationItemRef {
  kind: OwnedItemKind
  id: string
}

/** Something on this machine the item names, which the host must have too. */
export type MigrationReferenceKind =
  | "workflow"
  | "character"
  | "skill"
  | "agent-team"
  | "plan"
  | "conversation"
  | "mcp-server"
  | "external-agent"
  | "workspace"
  | "integration-account"
  | "connector-instance"

export type MigrationBlocker =
  /** The host could not be reached to check. */
  | { kind: "host-unreachable"; detail: string }
  /** The host does not advertise `always-on.migration`: it is too old to receive work. */
  | { kind: "host-too-old" }
  /** The item already runs on a paired host. */
  | { kind: "already-moved"; hostLabel: string }
  /** The classifier found it bound to this machine. */
  | { kind: "machine-bound"; reason: MachineBoundReason }
  /** A plugin it needs is not installed on the host. Resolved by plugin transfer. */
  | { kind: "plugin-missing"; pluginId: string; version: string }
  /** The host has the plugin at another version. Resolved by plugin transfer. */
  | { kind: "plugin-version-mismatch"; pluginId: string; version: string; hostVersion: string }
  /** The host's Bot catalog has no such definition at this version. */
  | { kind: "bot-definition-missing"; definitionId: string; version: string; pluginId?: string }
  /** Something the item names does not exist on the host. */
  | { kind: "reference-missing"; reference: MigrationReferenceKind; id: string }
  /** It depends on another item that must move first, or together. */
  | { kind: "depends-on"; item: MigrationItemRef; label: string }
  /** The host already holds a different item under this id. */
  | { kind: "id-conflict"; id: string }
  /** A secret it needs could not be read on this machine to carry over. */
  | { kind: "secret-unreadable"; name: string }

/**
 * Every blocker kind, in the order the guided flow lists them. The UI keys
 * its labels on these; a kind added to the union without a place here fails
 * the build.
 */
export const MIGRATION_BLOCKER_KINDS = [
  "host-unreachable",
  "host-too-old",
  "already-moved",
  "machine-bound",
  "plugin-missing",
  "plugin-version-mismatch",
  "bot-definition-missing",
  "reference-missing",
  "depends-on",
  "id-conflict",
  "secret-unreadable",
] as const satisfies readonly MigrationBlocker["kind"][]

const everyBlockerKindListed: Exclude<
  MigrationBlocker["kind"],
  (typeof MIGRATION_BLOCKER_KINDS)[number]
> extends never
  ? true
  : never = true
void everyBlockerKindListed

/** Blockers the plugin transfer step can clear, so the flow offers it instead of a dead end. */
export function isResolvableByPluginTransfer(blocker: MigrationBlocker): boolean {
  return blocker.kind === "plugin-missing" || blocker.kind === "plugin-version-mismatch"
}

export type MigrationNote =
  /** The host learns where to deliver to a chat only after that chat writes to the bot. */
  | { kind: "conversation-address-relearned"; conversationKey: string }
  /** A secret travels to the host's keychain over the paired channel. */
  | { kind: "secret-transferred"; name: string }
  /** Scheduled messages set up in the connector's chats move with it. */
  | { kind: "schedules-travel"; count: number }
  /**
   * Its workspace goes along without its folders: the host clones the
   * repository with the git credential it holds for that git host
   * (ADR-0224 A11).
   */
  | { kind: "workspace-travels"; workspace: string; remoteUrl: string }

export interface MigrationPreflight {
  item: MigrationItemRef
  label: string
  /** The item's status here, restored by a take-back that cannot read the host's. */
  localStatus: string
  /** True when nothing blocks the move. */
  ready: boolean
  blockers: MigrationBlocker[]
  notes: MigrationNote[]
  /** Plugins the host needs before this item can run there, with the version this machine has. */
  plugins: { pluginId: string; version: string }[]
  checkedAt: number
}

/** What a move or take-back of one item ended as. */
export interface MigrationOutcome {
  item: MigrationItemRef
  operationId: string
  ok: boolean
  /** Where the journal stands; `completed` when the operation finished. */
  state: string
  error?: string
}
