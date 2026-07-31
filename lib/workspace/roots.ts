import { nanoid } from "nanoid"
import type { Project } from "@/types"
import type { WorkspaceRoot } from "@/types/workspace"

/**
 * Pure helpers over `Project.roots` — the single source of truth for a
 * workspace's mounted directories. The legacy `rootDir` / `additionalDirs`
 * fields are derived mirrors kept in sync via `syncDerivedDirFields`.
 */

/** The primary root (the cwd), or undefined for a rootless workspace. */
export function primaryRootOf(project: Pick<Project, "roots">): WorkspaceRoot | undefined {
  return project.roots?.find((r) => r.isPrimary) ?? project.roots?.[0]
}

/** Resolve the linked project and primary root for a chat/editor session. */
export function resolveSessionProjectRoot(
  session: { projectId?: string } | null | undefined,
  projects: readonly Pick<Project, "id" | "roots">[]
): { project?: Pick<Project, "id" | "roots">; root?: WorkspaceRoot } {
  if (!session?.projectId) return {}
  const project = projects.find((candidate) => candidate.id === session.projectId)
  if (!project) return {}
  const root = primaryRootOf(project)
  return root ? { project, root } : { project }
}

/** Non-primary root paths (forwarded as additionalDirectories). */
export function additionalDirsOf(project: Pick<Project, "roots">): string[] {
  const primary = primaryRootOf(project)
  return (project.roots ?? []).filter((r) => r !== primary).map((r) => r.path)
}

/** Every root path, primary first. */
export function allRootPaths(project: Pick<Project, "roots">): string[] {
  const primary = primaryRootOf(project)
  if (!primary) return []
  return [primary.path, ...additionalDirsOf(project)]
}

/**
 * Dedupe by path, drop empties, guarantee exactly one primary (the first if
 * none was flagged). Returns a fresh array.
 */
export function normalizeRoots(roots: WorkspaceRoot[]): WorkspaceRoot[] {
  const seen = new Set<string>()
  const cleaned: WorkspaceRoot[] = []
  for (const r of roots) {
    const path = r.path?.trim()
    if (!path || seen.has(path)) continue
    seen.add(path)
    cleaned.push({ ...r, path })
  }
  if (cleaned.length === 0) return []
  const primaryIdx = cleaned.findIndex((r) => r.isPrimary)
  const chosen = primaryIdx >= 0 ? primaryIdx : 0
  return cleaned.map((r, i) => ({ ...r, isPrimary: i === chosen }))
}

/** Recompute the deprecated rootDir/additionalDirs mirrors from `roots`. */
export function syncDerivedDirFields<T extends Project>(project: T): T {
  const primary = primaryRootOf(project)
  const additional = additionalDirsOf(project)
  return {
    ...project,
    rootDir: primary?.path,
    additionalDirs: additional.length > 0 ? additional : undefined,
  }
}

/** Build a normalized roots array from the legacy rootDir + additionalDirs. */
export function rootsFromLegacy(
  rootDir: string | undefined,
  additionalDirs: string[] | undefined
): WorkspaceRoot[] {
  const roots: WorkspaceRoot[] = []
  if (rootDir?.trim()) roots.push({ id: `root-${nanoid()}`, path: rootDir.trim(), isPrimary: true })
  for (const d of additionalDirs ?? []) {
    if (d?.trim()) roots.push({ id: `root-${nanoid()}`, path: d.trim() })
  }
  return normalizeRoots(roots)
}
