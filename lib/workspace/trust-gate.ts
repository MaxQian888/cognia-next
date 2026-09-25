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
  /**
   * The roots with no grant, primary first. Non-empty exactly when
   * `restricted`. Lets a caller with nobody watching (a scheduled run) name
   * what the user has to trust instead of only saying that something is
   * untrusted.
   */
  untrustedRoots: string[]
}

/** Trust does not apply: nothing restricted, and no proof minted. */
function ungated(): WorkspaceTrustForSend {
  return { restricted: false, trustedRoots: [], untrustedRoots: [] }
}

export async function resolveWorkspaceTrustForSend(
  project: Pick<Project, "roots"> | null | undefined,
  opts: { enabled: boolean; onWeb: boolean }
): Promise<WorkspaceTrustForSend> {
  if (opts.onWeb || !opts.enabled || !project) return ungated()
  const paths = allRootPaths(project)
  if (paths.length === 0) return ungated()
  const verdicts = await Promise.all(paths.map((p) => isWorkspaceTrusted(p)))
  const untrustedRoots = paths.filter((_, index) => !verdicts[index])
  const restricted = untrustedRoots.length > 0
  return { restricted, trustedRoots: restricted ? [] : paths, untrustedRoots }
}
