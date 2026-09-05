/**
 * One Feishu/Lark Bitable table as a sync provider (spec 2026-09-06 D10).
 *
 * The binding carries a field map: which column is the title, which the
 * status, and which option text stands for each board status. Every field
 * the map names is pulled and pushed. A field the map leaves out is simply
 * not part of the sync, so a table can be bound with nothing but a title
 * column and still round-trip.
 *
 * Records carry `last_modified_time` when the API sends it. When it does
 * not, the pull time stands in, which makes the remote look "changed" on
 * every pass and lets a remote edit land unless a person edited the same
 * field more recently. That is the honest default for a table with no clock.
 */

import { withLarkAuthedApi, type LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type {
  Issue,
  IssueExternalRef,
  IssuePriority,
  IssueProject,
  IssueStatus,
  IssueSyncField,
  LarkBitableFieldMap,
} from "@/types/issues"
import { ISSUE_PRIORITIES, ISSUE_STATUSES } from "@/types/issues"
import type {
  IssueSyncBinding,
  IssueSyncProvider,
  PullOptions,
  PullResult,
  PushOutcome,
  RemoteIssue,
  RemotePatch,
} from "../types"
import {
  bitableCellDate,
  bitableCellNumber,
  bitableCellText,
  createBitableRecord,
  listBitableRecords,
  updateBitableRecord,
  type BitableRecord,
} from "./lark-api"

export const LARK_BITABLE_PROVIDER_ID = "lark-bitable"

export interface LarkBitableProviderDeps {
  withApi?: <T>(adapterId: string, fn: (api: LarkAuthedApi) => Promise<T>) => Promise<T>
  now?: () => number
}

/** Which sync fields the map covers, in the engine's order. */
export function mappedFields(map: LarkBitableFieldMap): IssueSyncField[] {
  const out: IssueSyncField[] = ["title"]
  if (map.description) out.push("description")
  if (map.status) out.push("status")
  if (map.priority) out.push("priority")
  if (map.assignee) out.push("assignee")
  if (map.dueDate) out.push("dueDate")
  if (map.estimate) out.push("estimate")
  return out
}

function statusFromOption(map: LarkBitableFieldMap, text: string | null): IssueStatus | undefined {
  if (!text) return undefined
  const values = map.statusValues ?? {}
  for (const status of ISSUE_STATUSES) {
    if ((values[status] ?? status).toLowerCase() === text.trim().toLowerCase()) return status
  }
  return undefined
}

function optionFromStatus(map: LarkBitableFieldMap, status: IssueStatus): string {
  return map.statusValues?.[status] ?? status
}

function priorityFromText(text: string | null): IssuePriority | undefined {
  if (!text) return undefined
  const lower = text.trim().toLowerCase()
  return ISSUE_PRIORITIES.find((priority) => priority === lower)
}

export function bitableRecordToRemote(
  record: BitableRecord,
  map: LarkBitableFieldMap,
  pulledAt: number
): RemoteIssue | null {
  const title = bitableCellText(record.fields[map.title])
  if (!title?.trim()) return null
  const status = map.status
    ? statusFromOption(map, bitableCellText(record.fields[map.status]))
    : undefined
  const remote: RemoteIssue = {
    externalId: record.recordId,
    label: title,
    title: title.trim(),
    status: status ?? "backlog",
    remoteUpdatedAt: record.lastModifiedAt ?? pulledAt,
  }
  if (map.description) remote.description = bitableCellText(record.fields[map.description]) ?? ""
  if (map.priority) {
    const priority = priorityFromText(bitableCellText(record.fields[map.priority]))
    if (priority) remote.priority = priority
  }
  if (map.assignee) remote.assigneeLabel = bitableCellText(record.fields[map.assignee])
  if (map.dueDate) remote.dueDate = bitableCellDate(record.fields[map.dueDate])
  if (map.estimate) remote.estimate = bitableCellNumber(record.fields[map.estimate])
  return remote
}

/** The `fields` body for a record write, from a patch and the map. */
export function bitableFieldsFromPatch(
  patch: RemotePatch,
  map: LarkBitableFieldMap
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (patch.title !== undefined) fields[map.title] = patch.title
  if (patch.description !== undefined && map.description) {
    fields[map.description] = patch.description ?? ""
  }
  if (patch.status !== undefined && map.status)
    fields[map.status] = optionFromStatus(map, patch.status)
  if (patch.priority !== undefined && map.priority) fields[map.priority] = patch.priority
  if (patch.dueDate !== undefined && map.dueDate) fields[map.dueDate] = patch.dueDate
  if (patch.estimate !== undefined && map.estimate) fields[map.estimate] = patch.estimate
  return fields
}

export function bitableFieldsFromIssue(
  issue: Issue,
  map: LarkBitableFieldMap
): Record<string, unknown> {
  return bitableFieldsFromPatch(
    {
      title: issue.title,
      description: issue.description ?? null,
      status: issue.status,
      priority: issue.priority,
      dueDate: issue.dueDate ?? null,
      estimate: issue.estimate ?? null,
    },
    map
  )
}

export function createLarkBitableSyncProvider(
  deps: LarkBitableProviderDeps = {}
): IssueSyncProvider {
  const withApi =
    deps.withApi ??
    (<T>(adapterId: string, fn: (api: LarkAuthedApi) => Promise<T>) =>
      withLarkAuthedApi({ adapterId }, (api) => fn(api)))
  const now = deps.now ?? Date.now

  return {
    id: LARK_BITABLE_PROVIDER_ID,
    label: "Lark Bitable",
    pullFields: ["title", "description", "status", "priority", "assignee", "dueDate", "estimate"],
    pushFields: ["title", "description", "status", "priority", "dueDate", "estimate"],

    resolveBindings(containers: readonly IssueProject[]): IssueSyncBinding[] {
      const seen = new Set<string>()
      const bindings: IssueSyncBinding[] = []
      for (const container of [...containers].sort((a, b) => a.id.localeCompare(b.id))) {
        for (const resource of container.resources) {
          if (resource.kind !== "lark-bitable") continue
          const key = `${resource.adapterId}:${resource.appToken}:${resource.tableId}`
          if (seen.has(key)) continue
          seen.add(key)
          bindings.push({
            providerId: LARK_BITABLE_PROVIDER_ID,
            projectId: container.projectId,
            issueProjectId: container.id,
            projectKey: container.key,
            resource,
            key,
          })
        }
      }
      return bindings
    },

    async pull(binding: IssueSyncBinding, options: PullOptions): Promise<PullResult> {
      const resource = binding.resource
      if (resource.kind !== "lark-bitable") throw new Error("not a lark-bitable binding")
      const pulledAt = now()
      return withApi(resource.adapterId, async (api) => {
        const { records, truncated } = await listBitableRecords(
          api,
          resource.appToken,
          resource.tableId
        )
        const items = records
          .map((record) => bitableRecordToRemote(record, resource.fieldMap, pulledAt))
          .filter((item): item is RemoteIssue => item !== null)
          .filter(
            (item) =>
              options.full || options.since === undefined || item.remoteUpdatedAt >= options.since
          )
        return { items, notModified: false, truncated }
      })
    },

    async push(
      binding: IssueSyncBinding,
      ref: IssueExternalRef,
      patch: RemotePatch
    ): Promise<PushOutcome> {
      const resource = binding.resource
      if (resource.kind !== "lark-bitable") throw new Error("not a lark-bitable binding")
      const fields = bitableFieldsFromPatch(patch, resource.fieldMap)
      if (Object.keys(fields).length === 0) return { status: "applied" }
      await withApi(resource.adapterId, (api) =>
        updateBitableRecord(api, resource.appToken, resource.tableId, ref.externalId, fields)
      )
      return { status: "applied", remoteUpdatedAt: now() }
    },

    async create(binding: IssueSyncBinding, issue: Issue): Promise<IssueExternalRef> {
      const resource = binding.resource
      if (resource.kind !== "lark-bitable") throw new Error("not a lark-bitable binding")
      const recordId = await withApi(resource.adapterId, (api) =>
        createBitableRecord(
          api,
          resource.appToken,
          resource.tableId,
          bitableFieldsFromIssue(issue, resource.fieldMap)
        )
      )
      if (!recordId) throw new Error("Bitable did not return the created record")
      return {
        provider: LARK_BITABLE_PROVIDER_ID,
        externalId: recordId,
        label: issue.title,
        syncedAt: now(),
        remoteUpdatedAt: now(),
        meta: { binding: binding.key },
      }
    },
  }
}
