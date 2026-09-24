import type { AgentTeamDeliveryNode } from "@/types/agent/agent-team-runtime"
import type { GitStackLayerState } from "@/types/git"
import type { Stack } from "@/lib/stack/model"
import {
  assertPublishableStack,
  createGithubDeliveryAdapter,
  prepareAndPublishGithubStack,
  stackRootBase,
} from "./github-delivery-adapter"

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
  headSha: "abc",
  approvedHeadSha: "abc",
  approvedBaseBranch: "main",
  createdAt: 1,
  updatedAt: 1,
}

describe("GitHub draft publication recovery", () => {
  it("resumes persisted draft layers after child records have changed", async () => {
    const disable = __enableDbRuntimeForTesting()
    try {
      const db = getDb()
      await createDeliveryGraphService({}).create({
        id: "partial-graph",
        runId: "partial-run",
        repositories: [
          {
            repositoryId: "primary",
            baseBranch: "release",
            layers: [
              { id: "partial-a", branch: "a", title: "A" },
              { id: "partial-b", branch: "b", title: "B" },
            ],
          },
        ],
      })
      await db.agentTeamDeliveryNodes.update("partial-a", {
        pullRequestNumber: 1,
        pullRequestUrl: "https://github.com/acme/repo/pull/1",
        headSha: "sha-a",
        status: "ci_pending",
      })
      const request = jest.fn(async (route: string) =>
        route.startsWith("GET")
          ? { status: 200, headers: {}, data: [] }
          : {
              status: 201,
              headers: {},
              data: {
                number: 2,
                html_url: "https://github.com/acme/repo/pull/2",
                head: { sha: "sha-b" },
              },
            }
      )
      const recordParent = jest.fn(async () => {})
      const team = {
        config: { workingDir: "/repo", githubDeliveryPolicy: STACKED_DELIVERY_DEFAULTS },
      } as AgentTeam
      await expect(
        prepareAndPublishGithubStack(team, "partial-run", {
          resolveTeamRepo: async () => ({
            fullName: "acme/repo",
            defaultBranch: "main",
            defaultBranchExists: true,
          }),
          resolveOctokit: async () => ({ request }),
          recordParent,
          validateLayers: async () => [
            {
              branch: "a",
              parent: "release",
              head: "sha-a",
              containsParent: true,
              checkedOutIn: null,
            },
            { branch: "b", parent: "a", head: "sha-b", containsParent: true, checkedOutIn: null },
          ],
        })
      ).resolves.toBe("partial-graph")
      expect(request).toHaveBeenCalledWith(
        "POST /repos/{owner}/{repo}/pulls",
        expect.objectContaining({ head: "b", base: "a" })
      )
      expect(recordParent).toHaveBeenCalledWith("/repo", "a", "release")
      expect((await db.agentTeamDeliveryGraphs.get("partial-graph"))?.status).toBe("running")
    } finally {
      await getDb().delete()
      __resetDbForTesting()
      disable()
    }
  })
})

describe("GitHub stacked delivery adapter", () => {
  it("uses GitHub pull request, retarget, update and merge endpoints", async () => {
    const request = jest.fn(async (route: string, _params: unknown) => {
      if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")
        return { status: 200, headers: {}, data: { head: { sha: "abc" }, base: { ref: "main" } } }
      if (route.startsWith("GET")) return { status: 200, headers: {}, data: [] }
      if (route.startsWith("POST")) {
        return {
          status: 201,
          headers: {},
          data: { number: 42, html_url: node.pullRequestUrl, head: { sha: "abc" } },
        }
      }
      return { status: 200, headers: {}, data: { merged: true } }
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
      "GET /repos/{owner}/{repo}/pulls",
      "POST /repos/{owner}/{repo}/pulls",
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
    ])
    expect(request).toHaveBeenCalledWith(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      expect.objectContaining({ sha: "abc" })
    )
  })

  it("reuses an existing matching pull request after an uncertain publish", async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      data: [
        {
          number: 42,
          html_url: node.pullRequestUrl,
          head: { sha: "abc", ref: node.branch, repo: { full_name: "acme/repo" } },
          base: { ref: "main" },
        },
      ],
    })
    const adapter = createGithubDeliveryAdapter({
      octokit: { request },
      repositories: { primary: "acme/repo" },
    })
    await expect(
      adapter.createPullRequest({
        repositoryId: "primary",
        branch: node.branch,
        baseBranch: "main",
        title: "Layer 1",
        order: 0,
      })
    ).resolves.toMatchObject({ number: 42, headSha: "abc" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("refuses a merge without an approved matching revision", async () => {
    const request = jest.fn()
    const adapter = createGithubDeliveryAdapter({
      octokit: { request },
      repositories: { primary: "acme/repo" },
    })
    await expect(adapter.merge({ ...node, approvedHeadSha: undefined })).rejects.toThrow(
      /approved.*revision/i
    )
    await expect(adapter.merge({ ...node, headSha: "new" })).rejects.toThrow(/approved.*revision/i)
    expect(request).not.toHaveBeenCalled()
  })

  it("refuses a remotely retargeted pull request before merge", async () => {
    const request = jest.fn().mockResolvedValue({
      status: 200,
      data: { head: { sha: "abc" }, base: { ref: "release" } },
    })
    const adapter = createGithubDeliveryAdapter({
      octokit: { request },
      repositories: { primary: "acme/repo" },
    })
    await expect(adapter.merge(node)).rejects.toThrow(/target.*changed/)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe("GET /repos/{owner}/{repo}/pulls/{pull_number}")
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

describe("assertPublishableStack", () => {
  const stack: Stack = {
    id: "primary",
    repositoryRoot: "/repos/app",
    trunk: "main",
    model: "branchPerLayer",
    layers: [
      { id: "one", branch: "agent/one", title: "one", order: 0 },
      { id: "two", branch: "agent/two", title: "two", order: 1 },
    ],
  }

  function layerState(over: Partial<GitStackLayerState> & { branch: string }): GitStackLayerState {
    return {
      parent: null,
      head: "0".repeat(40),
      containsParent: true,
      checkedOutIn: null,
      ...over,
    }
  }

  it("records the intended parent of every layer before asking git anything", async () => {
    // Without this the run's work is invisible to the Stacks panel, and every
    // layer reports `parentUnrecorded` — the one problem writing the pointer
    // is supposed to fix.
    const recordParent = jest.fn(async () => {})
    await assertPublishableStack("/repos/app", stack, {
      recordParent,
      validateLayers: async () => [
        layerState({ branch: "agent/one", parent: "main" }),
        layerState({ branch: "agent/two", parent: "agent/one" }),
      ],
    })
    expect(recordParent.mock.calls).toEqual([
      ["/repos/app", "agent/one", "main"],
      ["/repos/app", "agent/two", "agent/one"],
    ])
  })

  it("refuses a chain that is only an order of completion, naming the layer", async () => {
    // Two agents that branched off the trunk in parallel produce exactly the
    // list this function is handed. Publishing it opens a pull request for
    // layer 2 whose diff also contains layer 1.
    await expect(
      assertPublishableStack("/repos/app", stack, {
        recordParent: async () => {},
        validateLayers: async () => [
          layerState({ branch: "agent/one", parent: "main" }),
          layerState({ branch: "agent/two", parent: "agent/one", containsParent: false }),
        ],
      })
    ).rejects.toThrow("agent/two does not contain agent/one")
  })

  it("refuses a layer whose branch never made it to the repository", async () => {
    await expect(
      assertPublishableStack("/repos/app", stack, {
        recordParent: async () => {},
        validateLayers: async () => [
          layerState({ branch: "agent/one", parent: "main" }),
          layerState({ branch: "agent/two", parent: "agent/one", head: null }),
        ],
      })
    ).rejects.toThrow("agent/two does not exist")
  })
})
import "fake-indexeddb/auto"

import { __enableDbRuntimeForTesting, __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createDeliveryGraphService } from "./delivery-graph"
import { STACKED_DELIVERY_DEFAULTS } from "@/lib/stack/team-policy"
import type { AgentTeam } from "@/types/agent/agent-team"
