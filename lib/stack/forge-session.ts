/**
 * Getting from "a repository on disk" to "a client that can open its pull
 * requests" — and saying precisely why not, when it cannot.
 *
 * The engine in this directory is deliberately host-neutral: `publishStack`
 * and `mergeStack` take a `ForgeStackAdapter` and never learn where it came
 * from. Something still has to do the resolution, and doing it inside a React
 * component means the four failure modes get collapsed into one disabled
 * button. They are not the same failure:
 *
 *   - no remote at all — the person has not pushed this repository anywhere;
 *   - a host we have no adapter for — nothing they do locally will help;
 *   - no credential — one `gh auth login` away;
 *   - ready.
 *
 * Each is a different sentence and only two of them are worth acting on, so
 * the result is a union rather than `ForgeStackAdapter | null`.
 *
 * The remote is part of the answer. Publishing a stack means pushing its
 * branches first, and pushing them to a different remote than the one the pull
 * requests were resolved from opens pull requests against branches that do not
 * exist.
 */

import type { GitRemote } from "@/types/git"
import type { OctokitLike } from "@/lib/github/pr-observe/types"

import { createGithubStackAdapter } from "./forge/github"
import { parseForgeRemote } from "./forge/remote"
import type { ForgeStackAdapter } from "./forge/types"

export type StackForge =
  | {
      status: "ready"
      /** `owner/name`, in the form the adapter takes. */
      repository: string
      /** The git remote the repository was resolved from — push here. */
      remote: string
      adapter: ForgeStackAdapter
    }
  /** No remote, or none that names a host. */
  | { status: "noRemote" }
  /** A real host with no adapter — GitLab, Gitea, GitHub Enterprise. */
  | { status: "unsupportedHost"; host: string; remote: string }
  /** The forge is known; there is no usable credential for it. */
  | { status: "noCredential"; repository: string; remote: string }

export interface StackForgeDeps {
  remotes(repositoryRoot: string): Promise<GitRemote[]>
  /** Null when no credential could be resolved. */
  octokit(repository: string): Promise<OctokitLike | null>
  adapter(octokit: OctokitLike): ForgeStackAdapter
}

const DEFAULT_DEPS: StackForgeDeps = {
  remotes: async (repositoryRoot) => {
    const { gitRemotes } = await import("@/lib/git/commands")
    return gitRemotes(repositoryRoot)
  },
  // Imported lazily and by path, not at module scope: the credential source is
  // the application's, and a static import would drag the Agent Team graph
  // into every consumer of the stack engine — including its own tests.
  octokit: async (repository) => {
    const { createResolveOctokit } = await import("@/lib/ai/agent/team/pr-feedback/resolvers")
    return createResolveOctokit()(repository)
  },
  adapter: (octokit) => createGithubStackAdapter({ octokit }),
}

/**
 * Pick the remote to publish against.
 *
 * `origin` when there is one, otherwise the first that names a forge. A
 * repository whose only remote is `upstream` is a fork checkout, and refusing
 * to look at it because it is not called `origin` is a worse answer than
 * trying — the fork refusal in `publishStack` is what catches that case, and
 * it catches it with a sentence instead of a shrug.
 */
export function pickForgeRemote(remotes: readonly GitRemote[]): GitRemote | null {
  const named = remotes.filter((remote) => (remote.fetchUrl || remote.pushUrl || "").trim())
  return named.find((remote) => remote.name === "origin") ?? named[0] ?? null
}

export async function openStackForge(
  repositoryRoot: string,
  deps?: Partial<StackForgeDeps>
): Promise<StackForge> {
  const resolved: StackForgeDeps = { ...DEFAULT_DEPS, ...deps }
  const remotes = await resolved.remotes(repositoryRoot).catch(() => [] as GitRemote[])
  const remote = pickForgeRemote(remotes)
  if (!remote) return { status: "noRemote" }

  const parsed = parseForgeRemote(remote.fetchUrl || remote.pushUrl || "")
  if (!parsed) return { status: "noRemote" }
  if (parsed.forge !== "github") {
    return { status: "unsupportedHost", host: parsed.host, remote: remote.name }
  }

  const octokit = await resolved.octokit(parsed.fullName).catch(() => null)
  if (!octokit) {
    return { status: "noCredential", repository: parsed.fullName, remote: remote.name }
  }
  return {
    status: "ready",
    repository: parsed.fullName,
    remote: remote.name,
    adapter: resolved.adapter(octokit),
  }
}
