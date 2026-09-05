/**
 * Create local issues from parsed rows (spec 2026-09-06, Import).
 *
 * Every row carries an `import:<format>` external ref keyed by its stable
 * id, so a row already in the workspace is skipped rather than duplicated.
 * Parents are created before children (rows are ordered so a parent always
 * precedes its children, and a child whose parent was skipped as a duplicate
 * still finds it through the ref). Labels are resolved by name in the
 * `issue` scope, created when missing. The outcome is counted, never
 * assumed, in the same shape the board's bulk actions report.
 */

import { createIssue, getIssueByExternalKey, setIssueParent } from "@/lib/db/issues"
import { ensureIssueLabels } from "@/lib/issues/sync/apply"
import type { IssueActor, IssueStatus } from "@/types/issues"
import type { ImportedIssue, IssueImportFormat } from "./parse"

export interface ImportIssuesInput {
  /** Owning workspace id. */
  projectId: string
  issueProjectId: string
  format: IssueImportFormat
  rows: readonly ImportedIssue[]
  /** Status for rows that name none. */
  defaultStatus?: IssueStatus
  /** Cycle to plan every created issue into. */
  cycleId?: string
  by: IssueActor
  /** Test injection. */
  now?: () => number
}

export interface ImportIssuesOutcome {
  created: number
  /** Rows already present (same import ref). */
  skipped: number
  failed: number
  /** Ids of the issues created, in row order. */
  createdIds: string[]
  errors: Array<{ externalId: string; error: string }>
}

export function importProviderId(format: IssueImportFormat): string {
  return `import:${format}`
}

/** Parents first, then children, preserving relative order otherwise. */
export function orderForCreation(rows: readonly ImportedIssue[]): ImportedIssue[] {
  const byId = new Map(rows.map((row) => [row.externalId, row]))
  const placed = new Set<string>()
  const out: ImportedIssue[] = []
  const visit = (row: ImportedIssue, guard: Set<string>) => {
    if (placed.has(row.externalId)) return
    if (guard.has(row.externalId)) return
    guard.add(row.externalId)
    const parent = row.parentExternalId ? byId.get(row.parentExternalId) : undefined
    if (parent) visit(parent, guard)
    placed.add(row.externalId)
    out.push(row)
  }
  for (const row of rows) visit(row, new Set())
  return out
}

export async function importIssues(input: ImportIssuesInput): Promise<ImportIssuesOutcome> {
  const provider = importProviderId(input.format)
  const outcome: ImportIssuesOutcome = {
    created: 0,
    skipped: 0,
    failed: 0,
    createdIds: [],
    errors: [],
  }
  const localIdByExternal = new Map<string, string>()
  const now = input.now ?? Date.now

  for (const row of orderForCreation(input.rows)) {
    try {
      const existing = await getIssueByExternalKey(provider, row.externalId)
      if (existing) {
        localIdByExternal.set(row.externalId, existing.id)
        outcome.skipped += 1
        continue
      }
      const labels = row.labels.length > 0 ? await ensureIssueLabels(row.labels) : []
      const parentId = row.parentExternalId
        ? localIdByExternal.get(row.parentExternalId)
        : undefined
      const created = await createIssue({
        projectId: input.projectId,
        issueProjectId: input.issueProjectId,
        title: row.title,
        ...(row.description ? { description: row.description } : {}),
        status: row.status ?? input.defaultStatus ?? "backlog",
        ...(row.priority ? { priority: row.priority } : {}),
        ...(row.assigneeLabel ? { assignee: { kind: "human", label: row.assigneeLabel } } : {}),
        createdBy: input.by,
        labelIds: labels.map((label) => label.id),
        ...(row.dueDate !== undefined ? { dueDate: row.dueDate } : {}),
        ...(row.estimate !== undefined ? { estimate: row.estimate } : {}),
        ...(input.cycleId ? { cycleId: input.cycleId } : {}),
        externalRefs: [
          {
            provider,
            externalId: row.externalId,
            ...(row.sourceId ? { label: row.sourceId } : {}),
            syncedAt: now(),
          },
        ],
      })
      localIdByExternal.set(row.externalId, created.id)
      // Set after creation rather than through `createIssue`'s `parentId`,
      // because the parent may be a pre-existing row found through its ref,
      // and the writer runs the loop and workspace checks either way.
      if (parentId) await setIssueParent(created.id, parentId, input.by)
      outcome.created += 1
      outcome.createdIds.push(created.id)
    } catch (cause) {
      outcome.failed += 1
      outcome.errors.push({
        externalId: row.externalId,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return outcome
}
