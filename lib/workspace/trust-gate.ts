import type { Project } from "@/types"
import { allRootPaths } from "@/lib/workspace/roots"
import { isWorkspaceTrusted } from "@/lib/db/trusted-workspaces"

/**
 * Authoritative send-time Workspace Trust gate. A workspace is restricted iff
 * any of its roots is untrusted. Web (no real local FS) and a disabled trust
 * setting both bypass. This is the enforcement source of truth used by the
 * build-options pipeline; the React `useWorkspaceTrust` hook mirrors it for UI.
 */
export async function isWorkspaceRestricted(
  project: Pick<Project, "roots"> | null | undefined,
  opts: { enabled: boolean; onWeb: boolean }
): Promise<boolean> {
  if (opts.onWeb || !opts.enabled || !project) return false
  const paths = allRootPaths(project)
  if (paths.length === 0) return false
  const verdicts = await Promise.all(paths.map((p) => isWorkspaceTrusted(p)))
  return verdicts.some((trusted) => !trusted)
}
