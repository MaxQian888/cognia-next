/**
 * Pure helpers over `IssueProjectResource` that the providers, the resource
 * dialog and the inspector share, so a new resource kind is described once.
 */

import type { IssueProjectResource } from "@/types/issues"

/** A stable identity for a resource within its container (React keys, dedup). */
export function resourceKey(resource: IssueProjectResource): string {
  switch (resource.kind) {
    case "github-repo":
      return `github-repo:${resource.repoFullName}`
    case "workspace-root":
      return `workspace-root:${resource.rootId}`
    case "lark-tasklist":
      return `lark-tasklist:${resource.adapterId}:${resource.tasklistGuid}`
    case "lark-bitable":
      return `lark-bitable:${resource.adapterId}:${resource.appToken}:${resource.tableId}`
  }
}

/** What a row prints for the resource. Never localised: these are identifiers. */
export function resourceLabel(resource: IssueProjectResource): string {
  switch (resource.kind) {
    case "github-repo":
      return resource.repoFullName
    case "workspace-root":
      return resource.rootId
    case "lark-tasklist":
      return resource.name
    case "lark-bitable":
      return resource.name
  }
}

/** Whether the resource feeds the sync engine (as opposed to a directory reference). */
export function isSyncedResource(resource: IssueProjectResource): boolean {
  switch (resource.kind) {
    case "github-repo":
      return true
    case "lark-tasklist":
    case "lark-bitable":
      return true
    case "workspace-root":
      return false
  }
}

/** Whether a `github-repo` binding imports rows (D1) rather than mirroring them. */
export function isGithubImportBinding(resource: IssueProjectResource): boolean {
  return resource.kind === "github-repo" && resource.sync?.mode === "import"
}
