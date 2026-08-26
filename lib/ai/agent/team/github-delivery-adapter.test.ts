import type { AgentTeamDeliveryNode } from "@/types/agent/agent-team-runtime"
import { createGithubDeliveryAdapter, stackRootBase } from "./github-delivery-adapter"

const node: AgentTeamDeliveryNode = {
  id: "layer-1",
  graphId: "graph-1",
  runId: "run-1",
  repositoryId: "primary",
  title: "Layer 1",
  order: 0,
  dependsOn: [],
  branch: "agent/layer-1",
  baseBranch: "main",
  status: "ci_pending",
  pullRequestNumber: 42,
  pullRequestUrl: "https://github.com/acme/repo/pull/42",
  createdAt: 1,
  updatedAt: 1,
}

describe("GitHub stacked delivery adapter", () => {
  it("uses GitHub pull request, retarget, update and merge endpoints", async () => {
    const request = jest.fn(async (route: string) => {
      if (route.startsWith("POST")) {
        return {
          status: 201,
          headers: {},
          data: { number: 42, html_url: node.pullRequestUrl, head: { sha: "abc" } },
        }
      }
      return { status: 200, headers: {}, data: {} }
    })
    const adapter = createGithubDeliveryAdapter({
      octokit: { request },
      repositories: { primary: "acme/repo" },
      observePullRequest: async () => ({
        ci: "passing",
        approved: true,
        mergeable: true,
        conflict: false,
      }),
    })

    expect(
      await adapter.createPullRequest({
        repositoryId: "primary",
        branch: node.branch,
        baseBranch: "main",
        title: node.title,
        order: 0,
      })
    ).toEqual({ number: 42, url: node.pullRequestUrl, headSha: "abc" })
    await adapter.retarget(node, "main")
    await adapter.updateBranch(node)
    await adapter.merge(node)

    expect(request.mock.calls.map(([route]) => route)).toEqual([
      "POST /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
    ])
  })

  it("fails before network access for an unknown repository binding", async () => {
    const adapter = createGithubDeliveryAdapter({
      octokit: { request: jest.fn() },
      repositories: {},
    })
    await expect(adapter.observe(node)).rejects.toThrow(/Unknown GitHub repository binding/)
  })
})

describe("stackRootBase", () => {
  it("takes the operator's declared base over anything resolved", () => {
    // A team may be stacking onto a release branch on purpose; the binding is
    // a statement about their repository, not a hint.
    expect(
      stackRootBase("primary", "release/2026.08", {
        fullName: "acme/app",
        defaultBranch: "main",
        defaultBranchExists: true,
      })
    ).toBe("release/2026.08")
  })

  it("falls back to the resolved trunk when it exists", () => {
    expect(
      stackRootBase("primary", undefined, {
        fullName: "acme/app",
        defaultBranch: "develop",
        defaultBranchSource: "remoteHead",
        defaultBranchExists: true,
      })
    ).toBe("develop")
  })

  it("refuses a guessed trunk that does not exist, naming the guess", () => {
    // Publishing onto it would fail at GitHub once per layer with an error
    // about the pull request rather than about the root.
    expect(() =>
      stackRootBase("primary", undefined, {
        fullName: "acme/app",
        defaultBranch: "main",
        defaultBranchSource: "guess",
        defaultBranchExists: false,
      })
    ).toThrow(/guessed `main`, which does not exist/)
  })

  it("refuses when no trunk was resolved at all", () => {
    expect(() => stackRootBase("primary", undefined, { fullName: "acme/app" })).toThrow(
      /no resolvable default branch/
    )
  })

  it("does not silently substitute `main`", () => {
    // The behaviour this replaced: `?? "main"`, which turned an unresolvable
    // trunk into a confident wrong answer.
    for (const resolved of [
      { fullName: "acme/app" },
      { fullName: "acme/app", defaultBranch: "main", defaultBranchExists: false },
    ]) {
      expect(() => stackRootBase("primary", undefined, resolved)).toThrow()
    }
  })
})
