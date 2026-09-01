/**
 * Issue tracker companion-sync handlers, plus the workspace rows the board
 * is scoped by.
 *
 * The phone mounts a complete issue board and a delivery-container list, and
 * both read Dexie tables that no handler ever filled. There are zero
 * `issue_*` and zero `label_*` commands, so sync is not one option among
 * several, it is the only path.
 *
 * `projects` is here for a less obvious reason. Every issue read filters on
 * `useProjectStore().activeProjectId`, and that setting is classified
 * `device-local`, so a phone resolves it to the literal `project-default` it
 * auto-created on first run. Mirroring `issues` alone would therefore still
 * render an empty board, because the phone had no way to name the workspace
 * those issues belong to. With the workspace list mirrored, the already
 * mounted `MobileWorkspaceChip` and `WorkspacePickerList` can switch to a
 * real one, and the phone keeps choosing for itself rather than following
 * whatever the desktop happens to have open.
 *
 * `issueCounters` is deliberately not synced: it is keyed by `scopeId`
 * instead of `id`, and it is the write-side identifier allocator. A read-only
 * mirror holding the allocator would be wrong even if the key fitted. It is
 * the only table of the tracker that stays behind.
 */

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { Project } from "@/types"
import type { Issue, IssueEvent, IssueProject, IssueRun } from "@/types/issues"
import type { LabelRow } from "@/types/labels"

import type { SyncCursor, SyncOutcome } from "../types"
import { runSyncHandler } from "./base"

/** A workspace as it crosses the wire: the three `Date` fields as epoch ms. */
export type WireProject = Omit<Project, "createdAt" | "updatedAt" | "lastAccessedAt"> & {
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
}

/**
 * Revive the timestamps `readProjectsDelta` flattened.
 *
 * JSON has no Date, so the host sends epoch ms. Writing those numbers
 * straight into Dexie would leave rows whose type says `Date` and whose value
 * is a number, which breaks at the first `.getTime()` in the switcher's sort.
 */
export function reviveProject(row: WireProject): Project {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    lastAccessedAt: new Date(row.lastAccessedAt),
  } as Project
}

/** Pull the workspace list the header chip, the switcher and the board share. */
export function syncProjects(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<WireProject>(
    {
      table: "projects",
      getTable: () => getDb().projects as never,
      applyRows: async (rows) => {
        await getDb().projects.bulkPut(rows.map(reviveProject) as never[])
      },
    },
    transport,
    cursor
  )
}

/** Pull the board itself. */
export function syncIssues(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<Issue>(
    { table: "issues", getTable: () => getDb().issues as never },
    transport,
    cursor
  )
}

/** Pull the delivery containers the board groups by. */
export function syncIssueProjects(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<IssueProject>(
    { table: "issueProjects", getTable: () => getDb().issueProjects as never },
    transport,
    cursor
  )
}

/** Pull the label catalogue, without which every chip renders a raw id. */
export function syncLabels(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<LabelRow>(
    { table: "labels", getTable: () => getDb().labels as never },
    transport,
    cursor
  )
}

/**
 * Pull the activity trail, comments included.
 *
 * The host cursors this on `ts` rather than `updatedAt`, because an event is
 * appended and never edited. That makes the pull append-only in practice: a
 * row already on the phone is never re-sent, and rows only leave through the
 * tombstone their issue records when it is deleted.
 */
export function syncIssueEvents(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<IssueEvent>(
    { table: "issueEvents", getTable: () => getDb().issueEvents as never },
    transport,
    cursor
  )
}

/**
 * Pull dispatch history.
 *
 * `executionRuns` already syncs and carries the generic run summary, but it
 * has no idea which issue asked for the work. These rows are what let the
 * detail sheet say that this issue was dispatched, to which engine, and how
 * it ended.
 */
export function syncIssueRuns(transport: Transport, cursor: SyncCursor): Promise<SyncOutcome> {
  return runSyncHandler<IssueRun>(
    { table: "issueRuns", getTable: () => getDb().issueRuns as never },
    transport,
    cursor
  )
}
