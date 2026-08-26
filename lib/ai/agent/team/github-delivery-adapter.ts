import { fetchPrObservation } from "@/lib/github/pr-observe/fetch"
import { parseRepoFullName, type OctokitLike } from "@/lib/github/pr-observe/types"
import type { AgentTeamDeliveryNode } from "@/types/agent/agent-team-runtime"
import type { AgentTeam } from "@/types/agent/agent-team"
import type { ScmDeliveryAdapter, ScmDeliveryObservation } from "./delivery-graph"
import { getDb } from "@/lib/db/schema"
import type { ResolvedTeamRepo } from "./pr-feedback/resolvers"
import { stackedDeliveryOn } from "@/lib/stack/team-policy"

export interface GithubDeliveryAdapterOptions {
  octokit: OctokitLike
  repositories: Record<string, string>
  observePullRequest?: (
    repositoryFullName: string,
    pullRequestNumber: number
  ) => Promise<ScmDeliveryObservation>
}

function ensureSuccess(status: number, operation: string): void {
  if (status < 200 || status >= 300) throw new Error(`GitHub ${operation} failed with ${status}`)
}

export function createGithubDeliveryAdapter(
  options: GithubDeliveryAdapterOptions
): ScmDeliveryAdapter {
  const repository = (repositoryId: string) => {
    const fullName = options.repositories[repositoryId]
    if (!fullName) throw new Error(`Unknown GitHub repository binding: ${repositoryId}`)
    return parseRepoFullName(fullName)
  }
  const pullNumber = (node: AgentTeamDeliveryNode): number => {
    if (!node.pullRequestNumber) throw new Error(`Delivery node ${node.id} has no pull request`)
    return node.pullRequestNumber
  }

  const observePullRequest =
    options.observePullRequest ??
    (async (repositoryFullName: string, number: number): Promise<ScmDeliveryObservation> => {
      const observation = await fetchPrObservation(
        options.octokit,
        repositoryFullName,
        { number },
        undefined,
        Date.now()
      )
      return {
        ci: observation.fetched ? observation.ci.summary : "unknown",
        approved: observation.fetched && observation.review.decision === "approved",
        mergeable: observation.fetched && observation.mergeability.mergeable,
        conflict: observation.fetched && observation.mergeability.conflict,
      }
    })

  return {
    async createPullRequest(input) {
      const repo = repository(input.repositoryId)
      const response = await options.octokit.request("POST /repos/{owner}/{repo}/pulls", {
        owner: repo.owner,
        repo: repo.name,
        title: input.title,
        head: input.branch,
        base: input.baseBranch,
        body: `AgentTeam stacked delivery layer ${input.order + 1}`,
      })
      ensureSuccess(response.status, "create pull request")
      const data = response.data as {
        number?: number
        html_url?: string
        head?: { sha?: string }
      }
      if (!data.number || !data.html_url || !data.head?.sha) {
        throw new Error("GitHub create pull request returned an incomplete response")
      }
      return { number: data.number, url: data.html_url, headSha: data.head.sha }
    },

    async observe(node) {
      const repo = repository(node.repositoryId)
      return observePullRequest(repo.fullName, pullNumber(node))
    },

    async retarget(node, baseBranch) {
      const repo = repository(node.repositoryId)
      const response = await options.octokit.request(
        "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner: repo.owner,
          repo: repo.name,
          pull_number: pullNumber(node),
          base: baseBranch,
        }
      )
      ensureSuccess(response.status, "retarget pull request")
    },

    async updateBranch(node) {
      const repo = repository(node.repositoryId)
      const response = await options.octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
        { owner: repo.owner, repo: repo.name, pull_number: pullNumber(node) }
      )
      ensureSuccess(response.status, "update pull request branch")
    },

    async merge(node) {
      const repo = repository(node.repositoryId)
      const response = await options.octokit.request(
        "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
        {
          owner: repo.owner,
          repo: repo.name,
          pull_number: pullNumber(node),
          merge_method: "squash",
        }
      )
      ensureSuccess(response.status, "merge pull request")
      const data = response.data as { merged?: boolean; message?: string }
      if (data.merged === false)
        throw new Error(data.message || "GitHub refused to merge pull request")
    },
  }
}

export interface ApproveAndMergeGithubStackOptions {
  resolveTeamRepo?: (path: string) => Promise<ResolvedTeamRepoLike | null>
  resolveOctokit?: (fullName: string) => Promise<OctokitLike | null>
}

/**
 * What the resolver reports back, with the trunk fields optional so a caller
 * that only needs `fullName` (approve-and-merge) can pass a narrower stub.
 */
export type ResolvedTeamRepoLike = {
  fullName: string
} & Partial<Pick<ResolvedTeamRepo, "defaultBranch" | "defaultBranchSource" | "defaultBranchExists">>

/** Resolve real GitHub bindings, persist the single stack approval, then merge fail-stop. */
export async function approveAndMergeGithubStack(
  team: AgentTeam,
  graphId: string,
  options: ApproveAndMergeGithubStackOptions = {}
): Promise<void> {
  let resolveTeamRepo = options.resolveTeamRepo
  let resolveOctokit = options.resolveOctokit
  if (!resolveTeamRepo || !resolveOctokit) {
    const { buildAgentTeamRuntimeDeps } = await import("../agent-team-runtime-deps")
    const deps = buildAgentTeamRuntimeDeps()
    resolveTeamRepo ??= deps.resolveTeamRepo
    resolveOctokit ??= deps.resolvePrObserveOctokit
  }
  if (!resolveTeamRepo || !resolveOctokit) {
    throw new Error("GitHub delivery credentials are unavailable")
  }
  const bindings =
    team.config.repositories && team.config.repositories.length > 0
      ? team.config.repositories
      : team.config.workingDir
        ? [{ id: "primary", path: team.config.workingDir }]
        : []
  const repositories: Record<string, string> = {}
  for (const binding of bindings) {
    const resolved = await resolveTeamRepo(binding.path)
    if (!resolved) throw new Error(`Repository ${binding.id} has no GitHub remote`)
    repositories[binding.id] = resolved.fullName
  }
  const first = Object.values(repositories)[0]
  if (!first) throw new Error("GitHub delivery requires a repository binding")
  const octokit = await resolveOctokit(first)
  if (!octokit) throw new Error("GitHub delivery credentials are unavailable")
  const { createDeliveryGraphService } = await import("./delivery-graph")
  const service = createDeliveryGraphService({
    adapter: createGithubDeliveryAdapter({ octokit, repositories }),
  })
  await service.approve(graphId)
  await service.merge(graphId)
}

/**
 * The branch a stack's bottom layer is based on.
 *
 * Two inputs, in order of authority. An explicit `baseBranch` on the repository
 * binding is an operator's statement about their own repository and wins
 * outright — including over a resolver that disagrees, because the operator may
 * be stacking onto a release branch on purpose.
 *
 * Otherwise the resolved trunk, but only when it exists. The alternative to
 * throwing here is publishing a stack rooted on a branch GitHub has never heard
 * of, which fails layer by layer with `Base ref must be a branch` — an error
 * that points at the pull request instead of at the root that produced it.
 * Refusing once, by name, is the difference between a fixable message and a
 * confusing one.
 */
export function stackRootBase(
  repositoryId: string,
  declaredBase: string | undefined,
  resolved: ResolvedTeamRepoLike
): string {
  if (declaredBase) return declaredBase
  const trunk = resolved.defaultBranch
  if (!trunk || resolved.defaultBranchExists === false) {
    const guess = trunk ? ` (guessed \`${trunk}\`, which does not exist)` : ""
    throw new Error(
      `Repository ${repositoryId} has no resolvable default branch${guess} — ` +
        `set a base branch on the repository binding`
    )
  }
  return trunk
}

export async function prepareAndPublishGithubStack(
  team: AgentTeam,
  runId: string,
  options: ApproveAndMergeGithubStackOptions = {}
): Promise<string | undefined> {
  const policy = team.config.githubDeliveryPolicy
  if (!stackedDeliveryOn(policy) || !policy) return undefined
  const db = getDb()
  const existing = await db.agentTeamDeliveryGraphs.where("runId").equals(runId).first()
  if (existing) return existing.id
  const children = await db.agentTeamChildRuns.where("runId").equals(runId).toArray()
  const bindings =
    team.config.repositories && team.config.repositories.length > 0
      ? team.config.repositories
      : team.config.workingDir
        ? [
            {
              id: "primary",
              role: "primary" as const,
              path: team.config.workingDir,
              writable: true,
            },
          ]
        : []
  const minLayers = Math.max(2, policy.minLayers)
  const maxLayers = Math.min(100, policy.maxLayers)
  const stackBindings = bindings.filter((binding) => {
    const count = children.filter(
      (child) => child.repositoryId === binding.id && child.status === "completed" && child.branch
    ).length
    return count >= minLayers
  })
  if (stackBindings.length === 0) return undefined

  let resolveTeamRepo = options.resolveTeamRepo
  let resolveOctokit = options.resolveOctokit
  if (!resolveTeamRepo || !resolveOctokit) {
    const { buildAgentTeamRuntimeDeps } = await import("../agent-team-runtime-deps")
    const deps = buildAgentTeamRuntimeDeps()
    resolveTeamRepo ??= deps.resolveTeamRepo
    resolveOctokit ??= deps.resolvePrObserveOctokit
  }
  if (!resolveTeamRepo || !resolveOctokit) throw new Error("GitHub delivery is unavailable")
  const repositories: Record<string, string> = {}
  const defaults: Record<string, string> = {}
  for (const binding of stackBindings) {
    const resolved = await resolveTeamRepo(binding.path)
    if (!resolved) throw new Error(`Repository ${binding.id} has no GitHub remote`)
    repositories[binding.id] = resolved.fullName
    defaults[binding.id] = stackRootBase(binding.id, binding.baseBranch, resolved)
  }
  const first = Object.values(repositories)[0]
  if (!first) return undefined
  const octokit = await resolveOctokit(first)
  if (!octokit) throw new Error("GitHub delivery credentials are unavailable")
  const { createDeliveryGraphService } = await import("./delivery-graph")
  const service = createDeliveryGraphService({
    adapter: createGithubDeliveryAdapter({ octokit, repositories }),
  })
  const graphId = `delivery:${runId}`
  await service.create({
    id: graphId,
    runId,
    repositories: stackBindings.map((binding) => ({
      repositoryId: binding.id,
      // Every id is populated above or the loop threw; no `"main"` fallback.
      baseBranch: defaults[binding.id]!,
      dependsOn: (binding.dependsOn ?? []).filter((id) =>
        stackBindings.some((item) => item.id === id)
      ),
      layers: children
        .filter(
          (child) =>
            child.repositoryId === binding.id && child.status === "completed" && child.branch
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, maxLayers)
        .map((child, index) => ({
          id: `delivery:${child.id}`,
          branch: child.branch!,
          title: `AgentTeam layer ${index + 1}: ${child.taskId}`,
        })),
    })),
  })
  await service.publish(graphId)
  return graphId
}
