/**
 * An in-memory forge.
 *
 * Not a mock of GitHub — a second implementation. It is what the publish and
 * merge tests run against, and its existence is the check that the engine
 * contains no GitHub: anything the engine needs that this cannot provide is a
 * leak of one forge's shape into the shared layer.
 *
 * It models the parts that actually change behaviour — a pull request has a
 * base branch that retargeting moves, merging is refused unless the
 * observation allows it, and native stack registration can be turned off — and
 * nothing else.
 */

import type {
  CreatePullRequestInput,
  ForgeMergeMethod,
  ForgeObservation,
  ForgePullRequest,
  ForgeStackAdapter,
  ForgeStackCapabilities,
} from "./types"

export interface FakeForgeOptions {
  capabilities?: Partial<ForgeStackCapabilities>
  /** Per-branch observation. Anything absent is passing, approved, mergeable. */
  observations?: Record<string, Partial<ForgeObservation>>
}

export interface FakeForge extends ForgeStackAdapter {
  readonly pullRequests: Map<number, ForgePullRequest & { branch: string; repository: string }>
  readonly merged: Array<{ pullRequest: number; method: ForgeMergeMethod }>
  readonly comments: Array<{ pullRequest: number; body: string }>
  readonly registered: Array<{ repository: string; pullRequests: number[] }>
  /** Change what an observation reports, mid-test. */
  setObservation(branch: string, observation: Partial<ForgeObservation>): void
}

const HEALTHY: ForgeObservation = {
  ci: "passing",
  review: "approved",
  mergeable: true,
  conflict: false,
  merged: false,
}

export function createFakeForge(options: FakeForgeOptions = {}): FakeForge {
  const capabilities: ForgeStackCapabilities = {
    nativeStacks: true,
    canPushToTarget: true,
    allowedMergeMethods: ["squash", "rebase", "merge"],
    ...options.capabilities,
  }
  const observations = new Map<string, Partial<ForgeObservation>>(
    Object.entries(options.observations ?? {})
  )
  const pullRequests = new Map<number, ForgePullRequest & { branch: string; repository: string }>()
  const merged: Array<{ pullRequest: number; method: ForgeMergeMethod }> = []
  const comments: Array<{ pullRequest: number; body: string }> = []
  const registered: Array<{ repository: string; pullRequests: number[] }> = []
  let nextNumber = 1

  const find = (pullRequest: number) => {
    const found = pullRequests.get(pullRequest)
    if (!found) throw new Error(`fake forge: no pull request ${pullRequest}`)
    return found
  }

  return {
    id: "fake",
    pullRequests,
    merged,
    comments,
    registered,
    setObservation(branch, observation) {
      observations.set(branch, { ...observations.get(branch), ...observation })
    },
    async capabilities() {
      return capabilities
    },
    async findByBranch(repository, branch) {
      for (const entry of pullRequests.values()) {
        if (entry.repository === repository && entry.branch === branch) return { ...entry }
      }
      return null
    },
    async createPullRequest(input: CreatePullRequestInput) {
      const number = nextNumber++
      const created = {
        number,
        url: `https://fake/${input.repository}/pull/${number}`,
        baseBranch: input.baseBranch,
        headSha: `${input.branch}-sha`,
        branch: input.branch,
        repository: input.repository,
      }
      pullRequests.set(number, created)
      return { ...created }
    },
    async retarget(_repository, pullRequest, baseBranch) {
      find(pullRequest).baseBranch = baseBranch
    },
    async observe(_repository, pullRequest) {
      const entry = find(pullRequest)
      const wasMerged = merged.some((row) => row.pullRequest === pullRequest)
      return { ...HEALTHY, merged: wasMerged, ...observations.get(entry.branch) }
    },
    async merge(_repository, pullRequest, method) {
      find(pullRequest)
      merged.push({ pullRequest, method })
    },
    async comment(_repository, pullRequest, body) {
      find(pullRequest)
      comments.push({ pullRequest, body })
    },
    ...(capabilities.nativeStacks
      ? {
          async registerStack(repository: string, numbers: number[]) {
            registered.push({ repository, pullRequests: [...numbers] })
            const id = `stack-${registered.length}`
            for (const number of numbers) find(number).nativeStackId = id
            return id
          },
        }
      : {}),
  }
}
