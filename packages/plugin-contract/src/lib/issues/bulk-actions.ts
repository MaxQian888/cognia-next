/**
 * The plugin contract's share of `lib/issues/bulk-actions.ts`, which re-exports these.
 */
import type {
  IssueActor,
  IssueExternalRef,
  IssuePriority,
  IssueStatus,
  IssueTriageState,
} from "../../types/issues/index"
import type { IssueMoveDenial } from "./state-machine"

/**
 * One edit, expressed the same way whether it lands on one issue or twelve.
 *
 * `title` and `description` are in the vocabulary but deliberately absent from
 * `menu-model.ts`, so they never appear in a bulk menu: setting one title on a
 * dozen issues is not an edit anybody wants. They reach here from the
 * inspector's inline text editors, which pass a single item.
 */
export type IssueBulkAction =
  | { kind: "status"; to: IssueStatus }
  | { kind: "title"; to: string }
  | { kind: "description"; to: string }
  | { kind: "priority"; to: IssuePriority }
  | { kind: "assignee"; to: IssueActor | null }
  | { kind: "addLabel"; labelId: string }
  | { kind: "removeLabel"; labelId: string }
  | { kind: "project"; issueProjectId: string }
  /** Planning fields (v223). `null` clears. */
  | { kind: "cycle"; cycleId: string | null }
  | { kind: "dueDate"; to: number | null }
  | { kind: "estimate"; to: number | null }
  /** Sub-issue stage (`Issue.stage`). `null` unstages. */
  | { kind: "stage"; to: number | null }
  /** Into triage (`"pending"`) or accepted out of it (`null`). */
  | { kind: "triage"; to: IssueTriageState | null }
  /** Relations (v223). Single-item by nature, so absent from `menu-model`. */
  | { kind: "parent"; parentId: string | null }
  | { kind: "addBlocker"; blockerId: string }
  | { kind: "removeBlocker"; blockerId: string }
  | { kind: "linkExternal"; ref: IssueExternalRef }
  | { kind: "unlinkExternal"; ref: Pick<IssueExternalRef, "provider" | "externalId"> }
  /**
   * Append a comment. Single-item by nature, like `title`. `mentions` are the
   * declared ids from the composer's person picker (ADR-0207 §2); only the
   * collaboration source forwards them.
   */
  | { kind: "comment"; body: string; mentions?: readonly string[] }
  | { kind: "delete" }

export interface IssueBulkOutcome {
  /** Rows the write actually landed on. */
  applied: number
  /** Rows refused before any write — read-only source, or a guard denial. */
  skipped: number
  /** Rows whose write threw. */
  failed: number
  /**
   * Why the first skip happened, so the toast can explain rather than just
   * counting. `undefined` when nothing was skipped.
   */
  reason?: IssueMoveDenial
}
