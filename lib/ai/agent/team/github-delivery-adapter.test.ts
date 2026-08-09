import type { AgentTeamDeliveryNode } from "@/types/agent/agent-team-runtime"
import { createGithubDeliveryAdapter } from "./github-delivery-adapter"

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
