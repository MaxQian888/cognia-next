import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { nanoid } from "nanoid"
import type { Project } from "@/types"
import { isTauri } from "@/lib/tauri"
import { useProjectStore } from "@/stores/project/project-store"
import { primaryRootOf } from "@/lib/workspace/roots"

/** Last path segment, for the default workspace name. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * Create-or-activate a single-root workspace for `path`, then activate it.
 *
 * Dedupes: if a non-archived workspace already has `path` as its primary root,
 * that workspace is re-activated instead of creating a duplicate. This is the
 * shared sink for every "open" entry point (menu / Cmd+O / title-bar / deep
 * link / Source Control / New workspace), so re-opening a folder never piles up
 * workspaces.
 *
 * `name` overrides the folder-derived default; only creation passes it.
 */
export function openPathAsWorkspace(path: string, name?: string): Project | null {
  const trimmed = path.trim()
  if (!trimmed) return null
  const { projects, createProject, setActiveProject } = useProjectStore.getState()
  const existing = projects.find((p) => !p.isArchived && primaryRootOf(p)?.path === trimmed)
  if (existing) {
    setActiveProject(existing.id)
    return existing
  }
  const created = createProject({
    // "New workspace" passes the name the user typed, which the folder name is
    // only a sanitized derivative of ("My App: v2" becomes `My App- v2` on
    // disk). Opening an existing folder passes nothing and keeps the basename.
    name: name?.trim() || basename(trimmed),
    roots: [{ id: `root-${nanoid()}`, path: trimmed, isPrimary: true }],
  })
  setActiveProject(created.id)
  return created
}

/**
 * "Open folder as workspace" flow: pick a directory natively, then
 * create-or-activate a workspace for it via {@link openPathAsWorkspace}.
 * Returns the project, or null when not on desktop or the picker was cancelled.
 * Shared by the workspace switcher, ⌘K command palette, the File menu /
 * title-bar "Open Workspace", and the Source Control "Open folder".
 */
export async function openFolderAsWorkspace(): Promise<Project | null> {
  if (!isTauri()) return null
  const picked = await openDialog({ directory: true, multiple: false })
  if (typeof picked !== "string") return null
  return openPathAsWorkspace(picked)
}
