/**
 * Feishu/Lark Task v2 as a sync provider (spec 2026-09-06 D10).
 *
 * One `lark-tasklist` resource binds one tasklist to one container. Tasks
 * become local issues, sections become cycles (kind `cycle`), the assignee
 * member's name is cached as the assignee label, and completion maps onto the
 * board's status by category (a task is open or done, nothing in between, so
 * `coarseStatus` keeps a local `in_progress` where it is).
 *
 * Push covers title, description, due date and completion. A Lark task has
 * no priority, no labels and no estimate, so those never leave.
 */

import { withLarkAuthedApi, type LarkAuthedApi } from "@/lib/connectors/adapters/lark/authed-api"
import type {
  Issue,
  IssueExternalRef,
  IssueProject,
  IssueStatus,
  IssueSyncField,
} from "@/types/issues"
import { statusCategoryOf } from "@/types/issues"
import type {
  IssueSyncBinding,
  IssueSyncProvider,
  PullOptions,
  PullResult,
  PushOutcome,
  RemoteCycle,
  RemoteIssue,
  RemotePatch,
} from "../types"
import {
  createLarkTask,
  listLarkSections,
  listLarkTasklistTasks,
  updateLarkTask,
  type LarkTask,
  type LarkTaskPatch,
} from "./lark-api"

export const LARK_TASK_PROVIDER_ID = "lark-task"

export const LARK_TASK_PULL_FIELDS: readonly IssueSyncField[] = [
  "title",
  "description",
  "status",
  "assignee",
  "dueDate",
  "cycle",
]
export const LARK_TASK_PUSH_FIELDS: readonly IssueSyncField[] = [
  "title",
  "description",
  "status",
  "dueDate",
]

export function sectionExternalId(guid: string): string {
  return `section/${guid}`
}

export interface LarkTaskProviderDeps {
  /** Test seam over `withLarkAuthedApi`. */
  withApi?: <T>(adapterId: string, fn: (api: LarkAuthedApi) => Promise<T>) => Promise<T>
  now?: () => number
}

export function larkTaskToRemote(task: LarkTask, tasklistGuid: string): RemoteIssue {
  const assignee = task.members.find((member) => member.role === "assignee")
  const placement = task.tasklists.find((entry) => entry.tasklistGuid === tasklistGuid)
  return {
    externalId: task.guid,
    ...(task.url ? { url: task.url } : {}),
    label: task.summary,
    title: task.summary,
    description: task.description ?? "",
    status: task.completedAt !== undefined ? "done" : "todo",
    coarseStatus: true,
    assigneeLabel: assignee?.name ?? (assignee ? assignee.id : null),
    dueDate: task.dueAt ?? null,
    cycleExternalId: placement?.sectionGuid ? sectionExternalId(placement.sectionGuid) : null,
    remoteUpdatedAt: task.updatedAt ?? task.createdAt ?? 0,
  }
}

/** A board status onto a task's only two states. */
export function statusToLarkCompleted(status: IssueStatus): boolean {
  const category = statusCategoryOf(status)
  return category === "completed" || category === "canceled"
}

export function toLarkTaskPatch(patch: RemotePatch): LarkTaskPatch {
  const out: LarkTaskPatch = {}
  if (patch.title !== undefined) out.summary = patch.title
  if (patch.description !== undefined) out.description = patch.description ?? ""
  if (patch.dueDate !== undefined) out.dueAt = patch.dueDate
  if (patch.status !== undefined) out.completed = statusToLarkCompleted(patch.status)
  return out
}

export function createLarkTaskSyncProvider(deps: LarkTaskProviderDeps = {}): IssueSyncProvider {
  const withApi =
    deps.withApi ??
    (<T>(adapterId: string, fn: (api: LarkAuthedApi) => Promise<T>) =>
      withLarkAuthedApi({ adapterId }, (api) => fn(api)))
  const now = deps.now ?? Date.now

  return {
    id: LARK_TASK_PROVIDER_ID,
    label: "Lark tasks",
    pullFields: LARK_TASK_PULL_FIELDS,
    pushFields: LARK_TASK_PUSH_FIELDS,

    resolveBindings(containers: readonly IssueProject[]): IssueSyncBinding[] {
      const seen = new Set<string>()
      const bindings: IssueSyncBinding[] = []
      for (const container of [...containers].sort((a, b) => a.id.localeCompare(b.id))) {
        for (const resource of container.resources) {
          if (resource.kind !== "lark-tasklist") continue
          const key = `${resource.adapterId}:${resource.tasklistGuid}`
          if (seen.has(key)) continue
          seen.add(key)
          bindings.push({
            providerId: LARK_TASK_PROVIDER_ID,
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
      if (resource.kind !== "lark-tasklist") throw new Error("not a lark-tasklist binding")
      return withApi(resource.adapterId, async (api) => {
        const [sections, listed] = await Promise.all([
          listLarkSections(api, resource.tasklistGuid),
          listLarkTasklistTasks(api, resource.tasklistGuid),
        ])
        const cycles: RemoteCycle[] = sections.map((section) => ({
          externalId: sectionExternalId(section.guid),
          kind: "cycle",
          name: section.name,
          status: "active",
        }))
        // The Task API has no `since`, so the watermark filters client-side.
        const items = listed.tasks
          .map((task) => larkTaskToRemote(task, resource.tasklistGuid))
          .filter(
            (item) =>
              options.full || options.since === undefined || item.remoteUpdatedAt >= options.since
          )
        return { items, cycles, notModified: false, truncated: listed.truncated }
      })
    },

    async push(
      binding: IssueSyncBinding,
      ref: IssueExternalRef,
      patch: RemotePatch,
      _issue: Issue
    ): Promise<PushOutcome> {
      const resource = binding.resource
      if (resource.kind !== "lark-tasklist") throw new Error("not a lark-tasklist binding")
      const updated = await withApi(resource.adapterId, (api) =>
        updateLarkTask(api, ref.externalId, toLarkTaskPatch(patch), now())
      )
      return {
        status: "applied",
        ...(updated?.updatedAt !== undefined ? { remoteUpdatedAt: updated.updatedAt } : {}),
      }
    },

    async create(binding: IssueSyncBinding, issue: Issue): Promise<IssueExternalRef> {
      const resource = binding.resource
      if (resource.kind !== "lark-tasklist") throw new Error("not a lark-tasklist binding")
      const task = await withApi(resource.adapterId, (api) =>
        createLarkTask(api, {
          tasklistGuid: resource.tasklistGuid,
          summary: issue.title,
          ...(issue.description ? { description: issue.description } : {}),
          ...(issue.dueDate !== undefined ? { dueAt: issue.dueDate } : {}),
        })
      )
      if (!task) throw new Error("Lark did not return the created task")
      return {
        provider: LARK_TASK_PROVIDER_ID,
        externalId: task.guid,
        ...(task.url ? { url: task.url } : {}),
        label: task.summary,
        syncedAt: now(),
        remoteUpdatedAt: task.updatedAt ?? task.createdAt ?? now(),
        meta: { binding: binding.key },
      }
    },
  }
}
