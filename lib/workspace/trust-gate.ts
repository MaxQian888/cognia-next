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
  return (await resolveWorkspaceTrustForSend(project, opts)).restricted
}

export interface WorkspaceTrustForSend {
  restricted: boolean
  /** Present only when every active root has an explicit persisted grant. */
  trustedRoots: string[]
}

export async function resolveWorkspaceTrustForSend(
  project: Pick<Project, "roots"> | null | undefined,
  opts: { enabled: boolean; onWeb: boolean }
): Promise<WorkspaceTrustForSend> {
  if (opts.onWeb || !opts.enabled || !project) return { restricted: false, trustedRoots: [] }
  const paths = allRootPaths(project)
  if (paths.length === 0) return { restricted: false, trustedRoots: [] }
  const verdicts = await Promise.all(paths.map((p) => isWorkspaceTrusted(p)))
  const restricted = verdicts.some((trusted) => !trusted)
  return { restricted, trustedRoots: restricted ? [] : paths }
}
