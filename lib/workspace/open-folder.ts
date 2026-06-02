import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { nanoid } from "nanoid"
import type { Project } from "@/types"
import { isTauri } from "@/lib/tauri"
import { useProjectStore } from "@/stores/project/project-store"

/** Last path segment, for the default workspace name. */
function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/**
 * "Open folder as workspace" flow: pick a directory natively, create a
 * single-root workspace for it, and activate it. Returns the created project,
 * or null when not on desktop or the picker was cancelled. Shared by the
 * workspace switcher and the ⌘K command palette.
 */
export async function openFolderAsWorkspace(): Promise<Project | null> {
  if (!isTauri()) return null
  const picked = await openDialog({ directory: true, multiple: false })
  if (typeof picked !== "string") return null
  const { createProject, setActiveProject } = useProjectStore.getState()
  const created = createProject({
    name: basename(picked),
    roots: [{ id: `root-${nanoid()}`, path: picked, isPrimary: true }],
  })
  setActiveProject(created.id)
  return created
}
