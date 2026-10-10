/**
 * The workspace a remote sandbox clones (ADR-0221 D6).
 *
 * A remote sandbox cannot mount this machine's checkout, so it clones the
 * repository's remote at the branch the checkout tracks and works on its own
 * branch, `cognia/<agent>`, which the Host publishes when the session ends.
 * Uncommitted and unpushed local changes are therefore not in it — the run
 * starts from `<remote>@<baseRef>`, which the UI says.
 *
 * The sandbox never holds a credential: the Host's git proxy adds one (the
 * brain's, or the Host's own credential helpers), so `remoteUrl` must be an
 * https URL the Host can authenticate, and carries none itself. An SSH remote
 * is rewritten to the same repository over https; anything else cannot run
 * remotely and is refused `sandbox_workspace_remote_required`.
 */

import type { GitDefaultBranch, GitRemote, GitStatus } from "@/types/git"
import type { RemoteWorkspaceSource } from "@/types/sandbox/environment-spec"

/** `MAX_BRANCH_BYTES` in `git_proxy.rs`. */
const MAX_BRANCH_BYTES = 200

/** A subset of `git check-ref-format --branch`, as `is_valid_branch` in `git_proxy.rs`. */
export function isValidBranchName(branch: string): boolean {
  if (!branch || new TextEncoder().encode(branch).length > MAX_BRANCH_BYTES) return false
  if (branch === "HEAD" || branch === "@") return false
  if (/^[-/]|[/.]$/.test(branch)) return false
  if (branch.includes("..") || branch.includes("@{")) return false
  if (/[\x00-\x1f\x7f ~^:?*[\\]/.test(branch)) return false
  return branch
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"))
}

/**
 * The repository's https URL, from whatever form the checkout names it in.
 * `undefined` for a remote no Host could authenticate without a credential
 * in the URL (plain http, a local path, an unknown scheme).
 */
export function httpsRemoteUrl(remote: string): string | undefined {
  const raw = remote.trim()
  if (!raw) return undefined
  // scp-like `user@host:owner/repo.git`.
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)([^\s]+)$/.exec(raw)
  if (scp && !raw.includes("://")) return clean(`https://${scp[1]}/${scp[2]}`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return undefined
  }
  if (url.protocol === "ssh:" || url.protocol === "git+ssh:") {
    return clean(`https://${url.hostname}${url.pathname}`)
  }
  if (url.protocol !== "https:") return undefined
  return clean(`https://${url.host}${url.pathname}`)
}

function clean(candidate: string): string | undefined {
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  const path = url.pathname.replace(/\/+$/, "")
  if (!url.hostname || path.split("/").filter(Boolean).length === 0) return undefined
  return `https://${url.host}${path}`
}

/** The branch a remote sandbox works on for `agentId`. */
export function workBranchFor(agentId: string): string {
  const slug =
    agentId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "") || "agent"
  return `cognia/${slug}`
}

export interface RemoteWorkspaceGit {
  remotes: (root: string) => Promise<GitRemote[]>
  status: (root: string) => Promise<GitStatus>
  defaultBranch: (root: string, remote: string) => Promise<GitDefaultBranch>
}

export type RemoteWorkspaceResult =
  | { ok: true; source: RemoteWorkspaceSource }
  | {
      ok: false
      code: "sandbox_workspace_remote_required"
      detail: Record<string, string>
    }

/**
 * The source for a remote run of the checkout at `root`: its `origin` (else
 * first) remote over https, the branch its current branch tracks there (else
 * that remote's default branch), and the agent's work branch.
 */
export async function remoteWorkspaceSource(
  request: { root: string | null | undefined; agentId: string },
  git: RemoteWorkspaceGit
): Promise<RemoteWorkspaceResult> {
  const refuse = (reason: string): RemoteWorkspaceResult => ({
    ok: false,
    code: "sandbox_workspace_remote_required",
    detail: { reason },
  })
  const root = request.root?.trim()
  if (!root) return refuse("no_checkout")
  const remotes = await git.remotes(root).catch(() => [])
  const remote = remotes.find((entry) => entry.name === "origin") ?? remotes[0]
  if (!remote) return refuse("no_remote")
  const remoteUrl = httpsRemoteUrl(remote.fetchUrl)
  if (!remoteUrl) return refuse("remote_not_https")

  const status = await git.status(root).catch(() => undefined)
  const tracked = status?.upstream?.startsWith(`${remote.name}/`)
    ? status.upstream.slice(remote.name.length + 1)
    : undefined
  let baseRef = tracked && isValidBranchName(tracked) ? tracked : undefined
  if (!baseRef) {
    const fallback = await git.defaultBranch(root, remote.name).catch(() => undefined)
    // Only a branch the remote itself names: a local-only default would be a
    // clone of something that does not exist there.
    const onRemote = fallback?.source === "remoteHead" || fallback?.source === "remoteBranch"
    if (fallback?.exists && onRemote && isValidBranchName(fallback.branch)) {
      baseRef = fallback.branch
    }
  }
  if (!baseRef) return refuse("no_base_branch")

  const branch = workBranchFor(request.agentId)
  return { ok: true, source: { remoteUrl, baseRef, branch } }
}
