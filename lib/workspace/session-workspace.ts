import type { Project } from "@/types"

/**
 * Which workspace does a chat turn (or a panel bound to a session) belong to?
 *
 * The answer is the SESSION's own workspace — not whatever workspace happens to
 * be active in the UI. Those two diverge constantly: the conversation list can
 * span workspaces (`groupBy: "workspace"`), a background pane keeps streaming
 * after the user switches, and connector/scheduler-driven turns have no UI
 * focus at all. Resolving against the active workspace in those cases runs the
 * turn against another project's roots.
 *
 * The Dexie side already routes every scoped write through
 * `resolveSessionProjectId` (`lib/db/project-scope.ts`) for exactly this reason;
 * this is its in-memory twin for the send path and the panels.
 *
 * Precedence: the session's `projectId` → the active workspace → none.
 *
 * A session that names a workspace which is not in `projects` (deleted, or not
 * loaded yet) resolves to `null` rather than falling back to the active one.
 * Falling back would silently re-introduce the very mis-attribution this helper
 * exists to prevent — better to run with no workspace (the cwd chain then falls
 * to the session override / character / app default) than to run in a project
 * the user never picked.
 */
export function resolveSessionWorkspace<T extends Pick<Project, "id">>(
  session: { projectId?: string } | null | undefined,
  projects: readonly T[],
  activeProjectId?: string | null
): T | null {
  if (session?.projectId) {
    return projects.find((candidate) => candidate.id === session.projectId) ?? null
  }
  if (!activeProjectId) return null
  return projects.find((candidate) => candidate.id === activeProjectId) ?? null
}
