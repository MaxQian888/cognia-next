// Persistence for the workspace/project model. `useProjectStore` keeps the
// authoritative in-memory list + active pointer; these thin async writers
// mirror every mutation to Dexie so workspaces survive a reload. The store
// hydrates from `getAllProjects()` + `loadActiveProjectId()` on boot and
// fire-and-forgets `putProject` / `deleteProjectRow` after each mutation.
//
// The active-workspace pointer lives on the `AppSettings` singleton (not a
// second one-row table) — it reuses the already-hydrated settings store and
// its companion-sync `updatedAt` bump.

import { locateWorkspaceForPath } from "@/lib/workspace/locate-workspace"
import type { Project } from "@/types"
import { getDb } from "./schema"
import { getSettings, saveSettings } from "./settings"
import { recordTombstones } from "@/lib/sync/tombstones"

/** All persisted projects. Empty array when none have been saved yet. */
export async function getAllProjects(): Promise<Project[]> {
  return getDb().projects.toArray()
}

/** Upsert a single project row (keyed by `id`). */
export async function putProject(project: Project): Promise<void> {
  await getDb().projects.put(project)
}

/**
 * Remove a project row by id. No-op when the id is unknown.
 *
 * Cascades the issue tracker first (ADR-0132): containers, issues, their
 * activity trails and their runs are all scoped by this workspace id and have
 * no other owner, so dropping the workspace alone left them orphaned — invisible
 * to both tracker consoles, still holding their `&key` reservations, and still
 * syncing to paired devices. The tracker owns its own tombstones, so this stays
 * a call rather than a second copy of that cascade.
 */
export async function deleteProjectRow(id: string): Promise<void> {
  const { deleteIssueDataForWorkspace } = await import("./issue-projects")
  await deleteIssueDataForWorkspace(id)
  await getDb().projects.delete(id)
  // Companion-synced. A pull carries only rows that still exist, so without a
  // tombstone a deleted workspace stays in the phone's switcher forever, and
  // the phone can still be sitting on it as its own active scope.
  await recordTombstones("projects", [id])
}

/** The persisted active-workspace id, or null when none is set. */
export async function loadActiveProjectId(): Promise<string | null> {
  return (await getSettings()).activeProjectId ?? null
}

/** Persist the active-workspace pointer onto the settings singleton. */
export async function persistActiveProjectId(id: string | null): Promise<void> {
  await saveSettings({ activeProjectId: id })
}

/**
 * The workspace that mounts `path`, or null when none does.
 *
 * For callers that know a directory and nothing else — a CLI `--cwd`, a
 * terminal tab, an adopted worktree. Reads Dexie rather than the store because
 * those callers run in shells where no store is hydrated.
 */
export async function findWorkspaceIdForPath(
  path: string | null | undefined
): Promise<string | null> {
  if (!path?.trim()) return null
  try {
    return locateWorkspaceForPath(path, await getAllProjects())?.project.id ?? null
  } catch {
    return null
  }
}
