/**
 * Field-level bridge between a `RemoteIssue` and a local `Issue`.
 *
 * Three jobs, all pure except the writes:
 *   - read a field off either side in one comparable shape,
 *   - decide whether two such values differ,
 *   - write a remote value onto the local row through the SAME writers the
 *     board uses, attributed to the sync actor, with a `synced_in` event.
 *
 * Labels are the one field that needs a lookup: remote systems speak in
 * names, local rows in ids, so `ensureIssueLabels` resolves (and creates)
 * rows by name in the `issue` scope.
 */

import {
  addIssueLabel,
  moveIssue,
  removeIssueLabel,
  setIssueAssignee,
  setIssueCycle,
  setIssueDueDate,
  setIssueEstimate,
  updateIssue,
} from "@/lib/db/issues"
import { appendIssueEvent } from "@/lib/db/issue-events"
import { createLabel, listLabels } from "@/lib/db/labels"
import type { Issue, IssueActor, IssuePriority, IssueStatus, IssueSyncField } from "@/types/issues"
import type { LabelRow } from "@/types/labels"
import type { RemoteIssue } from "./types"

/** The comparable shape of one field on either side. */
export type RemoteFieldValue = string | number | null | readonly string[]

function sortedNames(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

/** Read one field off the remote item, or `undefined` when it does not carry it. */
export function remoteFieldValue(
  remote: RemoteIssue,
  field: IssueSyncField
): RemoteFieldValue | undefined {
  switch (field) {
    case "title":
      return remote.title
    case "description":
      return remote.description === undefined ? undefined : (remote.description ?? null) || null
    case "status":
      return remote.status
    case "priority":
      return remote.priority ?? undefined
    case "assignee":
      return remote.assigneeLabel === undefined ? undefined : (remote.assigneeLabel ?? null)
    case "labels":
      return remote.labels === undefined ? undefined : sortedNames(remote.labels)
    case "dueDate":
      return remote.dueDate === undefined ? undefined : (remote.dueDate ?? null)
    case "estimate":
      return remote.estimate === undefined ? undefined : (remote.estimate ?? null)
    case "cycle":
      return remote.cycleExternalId === undefined ? undefined : (remote.cycleExternalId ?? null)
  }
}

export interface LocalFieldContext {
  labelsById: ReadonlyMap<string, LabelRow>
  /** Local cycle id to the external id it carries for THIS provider. */
  cycleExternalIdOf: (cycleId: string) => string | undefined
}

/** Read one field off the local row in the same shape as `remoteFieldValue`. */
export function localFieldValue(
  issue: Issue,
  field: IssueSyncField,
  context: LocalFieldContext
): RemoteFieldValue {
  switch (field) {
    case "title":
      return issue.title
    case "description":
      return issue.description?.trim() ? issue.description : null
    case "status":
      return issue.status
    case "priority":
      return issue.priority
    case "assignee":
      return issue.assignee?.label ?? null
    case "labels":
      return sortedNames(
        issue.labelIds.map((id) => context.labelsById.get(id)?.name).filter((n): n is string => !!n)
      )
    case "dueDate":
      return issue.dueDate ?? null
    case "estimate":
      return issue.estimate ?? null
    case "cycle":
      return issue.cycleId ? (context.cycleExternalIdOf(issue.cycleId) ?? null) : null
  }
}

export function fieldValuesDiffer(a: RemoteFieldValue, b: RemoteFieldValue): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const left = Array.isArray(a) ? a : []
    const right = Array.isArray(b) ? b : []
    if (left.length !== right.length) return true
    return left.some((value, index) => value !== right[index])
  }
  return a !== b
}

/** Resolve label names to rows in the `issue` scope, creating what is missing. */
export async function ensureIssueLabels(names: readonly string[]): Promise<LabelRow[]> {
  const existing = await listLabels("issue")
  const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row]))
  const out: LabelRow[] = []
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    const key = name.toLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    const found = byName.get(key)
    if (found) {
      out.push(found)
      continue
    }
    const created = await createLabel({ scope: "issue", name })
    byName.set(key, created)
    out.push(created)
  }
  return out
}

export interface ApplyRemoteFieldOptions {
  /** Append a `synced_in` event naming the provider. Off when a person resolves a conflict. */
  record?: boolean
  provider?: string
  /** Local cycle id for a remote cycle external id, when the field is `cycle`. */
  cycleIdOf?: (externalId: string) => string | undefined
  /** True while a run holds the issue, which refuses a status write. */
  runActive?: boolean
}

/**
 * Write one remote value onto the local row through the board's own writers.
 * Returns false when the write was refused (a run owns the status column).
 */
export async function applyRemoteField(
  issue: Issue,
  field: IssueSyncField,
  value: RemoteFieldValue,
  by: IssueActor,
  options: ApplyRemoteFieldOptions = {}
): Promise<boolean> {
  switch (field) {
    case "title":
      if (typeof value !== "string" || !value.trim()) return false
      await updateIssue(issue.id, { title: value }, by)
      break
    case "description":
      await updateIssue(issue.id, { description: typeof value === "string" ? value : "" }, by)
      break
    case "status": {
      if (typeof value !== "string") return false
      const denial = await moveIssue({
        id: issue.id,
        to: value as IssueStatus,
        by,
        runActive: options.runActive ?? false,
      })
      if (denial) return false
      break
    }
    case "priority":
      if (typeof value !== "string") return false
      await updateIssue(issue.id, { priority: value as IssuePriority }, by)
      break
    case "assignee":
      await setIssueAssignee(
        issue.id,
        typeof value === "string" && value ? { kind: "human", label: value } : null,
        by
      )
      break
    case "labels": {
      const names = Array.isArray(value) ? value : []
      const rows = await ensureIssueLabels(names)
      const wanted = new Set(rows.map((row) => row.id))
      for (const id of issue.labelIds) {
        if (!wanted.has(id)) await removeIssueLabel(issue.id, id, by)
      }
      for (const id of wanted) {
        if (!issue.labelIds.includes(id)) await addIssueLabel(issue.id, id, by)
      }
      break
    }
    case "dueDate":
      await setIssueDueDate(issue.id, typeof value === "number" ? value : null, by)
      break
    case "estimate":
      await setIssueEstimate(issue.id, typeof value === "number" ? value : null, by)
      break
    case "cycle": {
      const cycleId =
        typeof value === "string" && value ? (options.cycleIdOf?.(value) ?? null) : null
      await setIssueCycle(issue.id, cycleId, by)
      break
    }
  }
  if (options.record !== false && options.provider) {
    await appendIssueEvent({
      issueId: issue.id,
      payload: { kind: "synced_in", provider: options.provider, field, by },
    })
  }
  return true
}
