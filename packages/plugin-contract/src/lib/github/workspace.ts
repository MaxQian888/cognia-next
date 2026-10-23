/**
 * The plugin contract's share of `lib/github/workspace.ts`, which re-exports these.
 */
export type WorkspaceBackend = "local" | "e2b"

export interface WorkspaceHandle {
  backend: WorkspaceBackend
  /** Filesystem path (local) or sandbox id (e2b). */
  path: string
  /** Repo this workspace was cloned from. */
  repoFullName: string
  /** Branch checked out. */
  branch: string
  /** Trusted source branch used to create the isolated target branch. */
  baseBranch?: string
  /** Wall clock ms when allocated. */
  createdAt: number
}

/**
 * Pluggable E2B backend. A repository Integration plugin may wire a real
 * implementation backed by the `e2b-sandbox` plugin when present.
 * Tests inject fakes.
 */
export interface E2BBackend {
  clone(opts: { repoFullName: string; branch: string; token: string }): Promise<WorkspaceHandle>
  commitAndPush(opts: {
    workspace: WorkspaceHandle
    message: string
    remoteBranch?: string
    /**
     * PAT / installation token for this push (ADR-0176).
     *
     * Optional on the interface so a backend that authenticates some other way
     * stays valid, but the sandbox backend requires it: its clone stores a
     * credential-FREE remote, and a long-running workspace outlives the
     * installation token it was cloned with. Passing the credential per push is
     * what lets a rotated token reach a workspace that already exists.
     */
    token?: string
  }): Promise<string>
  remove(handle: WorkspaceHandle): Promise<boolean>
}
