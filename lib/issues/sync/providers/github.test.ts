import type { IssueExternalRef, IssueProject } from "@/types/issues"
import type { OctokitLike } from "@/lib/github/issues"
import type { IssueSyncBinding } from "../types"
import {
  createGithubSyncProvider,
  extractIssueMentions,
  githubLoginOfAssignee,
  nextGithubAssignees,
  iterationExternalId,
  milestoneExternalId,
  statusToGithubState,
  toRemoteIssue,
  toUpdateIssueInput,
} from "./github"

jest.mock("@/lib/ai/agent/team/pr-feedback/resolvers", () => ({
  createResolveOctokit: () => async () => null,
}))
jest.mock("@/lib/integrations/action-runner", () => ({ executeIntegrationAction: jest.fn() }))
jest.mock("@/lib/issues/github-writeback", () => ({
  GITHUB_DELIVERY_PLUGIN_ID: "github-delivery",
  GITHUB_INTEGRATION_ID: "github",
  resolveGithubWritebackAccount: jest.fn(),
}))

function container(resources: IssueProject["resources"], id = "p1"): IssueProject {
  return {
    id,
    projectId: "w1",
    key: "MERC",
    name: "Mercury",
    status: "backlog",
    priority: "none",
    resources,
    createdAt: 1,
    updatedAt: 1,
  }
}

const importRepo = {
  kind: "github-repo" as const,
  repoFullName: "acme/one",
  addedAt: 1,
  sync: { mode: "import" as const, projectV2Number: 4 },
}

function binding(): IssueSyncBinding {
  return {
    providerId: "github",
    projectId: "w1",
    issueProjectId: "p1",
    projectKey: "MERC",
    resource: importRepo,
    key: "acme/one",
  }
}

describe("pure transforms", () => {
  it("scopes milestone identity by repository and GitHub host", () => {
    expect(milestoneExternalId(1, "acme/one")).not.toBe(milestoneExternalId(1, "acme/two"))
    expect(milestoneExternalId(1, "acme/one", "ghe.example")).not.toBe(
      milestoneExternalId(1, "acme/one")
    )
  })

  it("extracts identifiers of this container and #numbers of this repo", () => {
    const out = extractIssueMentions(
      "Fixes MERC-12 and merc-3, also closes #7 and see #7 again, not VEN-1 nor foo#9",
      "MERC",
      "acme/one"
    )
    expect(out.identifiers).toEqual(["MERC-12", "MERC-3"])
    expect(out.externalIds).toEqual(["acme/one#7"])
  })

  it("maps a mirror row to a remote issue, preferring the iteration over the milestone", () => {
    const base = {
      number: 5,
      title: "T",
      body: "B",
      state: "closed" as const,
      stateReason: "not_planned",
      assigneeLogins: ["a", "b"],
      labels: [{ name: "bug" }],
      htmlUrl: "https://x/5",
      updatedAt: 99,
      milestoneNumber: 2,
      etag: "e",
    }
    expect(toRemoteIssue(base, "acme/one", new Map())).toMatchObject({
      externalId: "acme/one#5",
      status: "canceled",
      assigneeLabel: "a",
      labels: ["bug"],
      cycleExternalId: milestoneExternalId(2, "acme/one"),
      remoteUpdatedAt: 99,
      meta: { etag: "e" },
    })
    expect(toRemoteIssue(base, "acme/one", new Map([[5, "it1"]])).cycleExternalId).toBe(
      iterationExternalId("it1")
    )
    expect(
      toRemoteIssue({ ...base, milestoneNumber: undefined }, "acme/one", new Map()).cycleExternalId
    ).toBeNull()
  })

  it("maps board statuses onto the two GitHub states through the category", () => {
    expect(statusToGithubState("backlog")).toEqual({ state: "open" })
    expect(statusToGithubState("in_review")).toEqual({ state: "open" })
    expect(statusToGithubState("done")).toEqual({ state: "closed", state_reason: "completed" })
    expect(statusToGithubState("canceled")).toEqual({
      state: "closed",
      state_reason: "not_planned",
    })
  })

  it("builds the updateIssue input from a patch, milestones only", () => {
    expect(
      toUpdateIssueInput("acme/one", 5, {
        title: "T",
        description: null,
        status: "done",
        labels: ["a"],
        cycleExternalId: milestoneExternalId(3, "acme/one"),
      })
    ).toEqual({
      repoFullName: "acme/one",
      issueNumber: 5,
      title: "T",
      body: "",
      state: "closed",
      stateReason: "completed",
      labels: ["a"],
      milestone: 3,
    })
    expect(toUpdateIssueInput("acme/one", 5, { cycleExternalId: null })).toEqual({
      repoFullName: "acme/one",
      issueNumber: 5,
      milestone: null,
    })
    expect(() => toUpdateIssueInput("acme/one", 5, { cycleExternalId: "iteration/x" })).toThrow(
      /iteration/
    )
    expect(
      toUpdateIssueInput("acme/one", 5, { cycleExternalId: milestoneExternalId(3, "acme/one") })
    ).toMatchObject({ milestone: 3 })
    expect(() =>
      toUpdateIssueInput("acme/one", 5, { cycleExternalId: milestoneExternalId(3, "acme/two") })
    ).toThrow(/repository/)
    expect(() => toUpdateIssueInput("acme/one", 5, { cycleExternalId: "milestone/3" })).toThrow(
      /repository/
    )
  })
})

describe("resolveBindings", () => {
  it("binds only import-mode repos, once each, with the container's key", () => {
    const provider = createGithubSyncProvider()
    const mirror = { kind: "github-repo" as const, repoFullName: "acme/mirror", addedAt: 1 }
    const bindings = provider.resolveBindings([
      container([mirror, importRepo], "p2"),
      container([importRepo], "p1"),
    ])
    expect(bindings).toEqual([
      expect.objectContaining({
        providerId: "github",
        issueProjectId: "p1",
        projectKey: "MERC",
        key: "acme/one",
      }),
    ])
  })
})

describe("pull", () => {
  function fakeOctokit(
    handlers: Record<string, (params: Record<string, unknown>) => unknown>
  ): OctokitLike {
    return {
      request: async (route, params = {}) => {
        const handler = handlers[route]
        if (!handler) throw new Error(`unexpected ${route}`)
        return { status: 200, headers: {}, data: handler(params) }
      },
    }
  }

  it("reads issues, milestones, the Projects v2 iterations and PR links in one pass", async () => {
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues": () => [
        {
          number: 1,
          title: "One",
          body: "b",
          state: "open",
          html_url: "https://x/1",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          milestone: { number: 9, title: "M9" },
          labels: [{ name: "bug" }],
          assignees: [],
        },
        {
          number: 2,
          title: "PR",
          state: "open",
          html_url: "h",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          pull_request: {},
        },
      ],
      "GET /repos/{owner}/{repo}/milestones": () => [
        { number: 9, title: "M9", state: "open", due_on: "2026-03-01T00:00:00Z", html_url: "m" },
      ],
      "POST /graphql": () => ({
        data: {
          repository: {
            projectV2: {
              fields: {
                nodes: [
                  {
                    __typename: "ProjectV2IterationField",
                    name: "Iteration",
                    configuration: {
                      iterations: [
                        { id: "it1", title: "Sprint 1", startDate: "2026-01-01", duration: 14 },
                      ],
                      completedIterations: [],
                    },
                  },
                ],
              },
              items: {
                nodes: [
                  {
                    content: {
                      __typename: "Issue",
                      number: 1,
                      repository: { nameWithOwner: "acme/one" },
                    },
                    fieldValues: { nodes: [{ iterationId: "it1", title: "Sprint 1" }] },
                  },
                  {
                    content: {
                      __typename: "Issue",
                      number: 1,
                      repository: { nameWithOwner: "acme/two" },
                    },
                    fieldValues: { nodes: [{ iterationId: "wrong-repo" }] },
                  },
                  {
                    content: {
                      __typename: "PullRequest",
                      number: 1,
                      repository: { nameWithOwner: "acme/one" },
                    },
                    fieldValues: { nodes: [{ iterationId: "wrong-type" }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
      "GET /repos/{owner}/{repo}/pulls": () => [
        {
          number: 20,
          title: "Fix MERC-4",
          body: "closes #1",
          html_url: "p",
          head: { ref: "merc-4-fix" },
          state: "closed",
          merged_at: "2026-02-01T00:00:00Z",
        },
        { number: 21, title: "unrelated", body: "", html_url: "q", head: { ref: "main" } },
      ],
    })
    const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => octokit })
    const result = await provider.pull(binding(), { since: 1 })
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).toMatchObject({
      externalId: "acme/one#1",
      cycleExternalId: iterationExternalId("it1"),
      labels: ["bug"],
    })
    expect(result.cycles?.map((c) => c.externalId).sort()).toEqual([
      iterationExternalId("it1"),
      milestoneExternalId(9, "acme/one"),
    ])
    const iteration = result.cycles?.find((c) => c.kind === "cycle")
    expect(iteration).toMatchObject({ name: "Sprint 1", startsAt: Date.parse("2026-01-01") })
    expect(result.links).toEqual([
      expect.objectContaining({
        provider: "github-pr",
        externalId: "acme/one#20",
        mentionsIdentifiers: ["MERC-4"],
        mentionsExternalIds: ["acme/one#1"],
        prState: "merged",
      }),
    ])
  })

  it("reads CI for open linked pull requests only, within the per-pass budget", async () => {
    const ciCalls: string[] = []
    const octokit = fakeOctokit({
      "GET /repos/{owner}/{repo}/issues": () => [],
      "GET /repos/{owner}/{repo}/milestones": () => [],
      "POST /graphql": () => ({ data: { repository: { projectV2: null } } }),
      "GET /repos/{owner}/{repo}/pulls": () => [
        { number: 30, title: "MERC-1", state: "open", head: { ref: "a", sha: "s30" } },
        { number: 31, title: "MERC-2", state: "open", head: { ref: "b", sha: "s31" } },
        { number: 32, title: "MERC-3", state: "closed", head: { ref: "c", sha: "s32" } },
      ],
      "GET /repos/{owner}/{repo}/commits/{ref}/check-runs": (params) => {
        ciCalls.push(String(params.ref))
        if (params.ref === "s31") throw new Error("403 checks:read")
        return {
          total_count: 1,
          check_runs: [{ name: "ci", status: "completed", conclusion: "failure" }],
        }
      },
      "GET /repos/{owner}/{repo}/commits/{ref}/status": () => ({ statuses: [] }),
    })
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => octokit,
      pullRequestCiLimit: 5,
    })
    const result = await provider.pull(binding(), { since: 1 })
    const byId = new Map(result.links?.map((link) => [link.externalId, link]))
    expect(byId.get("acme/one#30")).toMatchObject({ prState: "open", ciState: "failing" })
    // An unreadable CI leaves the link and its state in place.
    expect(byId.get("acme/one#31")).toMatchObject({ prState: "open" })
    expect(byId.get("acme/one#31")).not.toHaveProperty("ciState")
    expect(byId.get("acme/one#32")).not.toHaveProperty("ciState")
    expect(ciCalls).toEqual(["s30", "s31"])

    ciCalls.length = 0
    const budgeted = createGithubSyncProvider({
      resolveOctokitOrNull: async () => octokit,
      pullRequestCiLimit: 1,
    })
    await budgeted.pull(binding(), { since: 1 })
    expect(ciCalls).toEqual(["s30"])
  })

  it("fails the binding, not the run, when no credential resolves", async () => {
    const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => null })
    await expect(provider.pull(binding(), {})).rejects.toMatchObject({
      name: "MissingGithubCredentialError",
    })
  })
})

describe("push", () => {
  it.each([
    { cycleExternalId: "iteration/new" },
    { cycleExternalId: "iteration/new", title: "new title" },
  ])("rejects iteration changes without publishing or consuming the patch: %j", async (patch) => {
    const execute = jest.fn()
    const provider = createGithubSyncProvider({ execute: execute as never })
    await expect(
      provider.push!(
        binding(),
        { provider: "github", externalId: "acme/one#5" },
        patch,
        { id: "i1" } as never,
        { idempotencyKey: "k", by: { kind: "agent" } }
      )
    ).rejects.toThrow(/iteration/i)
    expect(execute).not.toHaveBeenCalled()
  })

  const ref: IssueExternalRef = { provider: "github", externalId: "acme/one#5" }
  const issue = { id: "i1" } as never

  it.each([null, "milestone/github.com/acme/one/3"])(
    "refuses replacing an existing Project iteration with %s",
    async (cycleExternalId) => {
      const execute = jest.fn()
      const request = jest.fn(async () => ({
        status: 200,
        headers: {},
        data: {
          data: {
            repository: {
              projectV2: {
                items: {
                  nodes: [
                    {
                      content: {
                        __typename: "Issue",
                        number: 5,
                        repository: { nameWithOwner: "acme/one" },
                      },
                      fieldValues: { nodes: [{ iterationId: "current" }] },
                    },
                  ],
                  pageInfo: { hasNextPage: false },
                },
              },
            },
          },
        },
      }))
      const provider = createGithubSyncProvider({
        execute: execute as never,
        resolveOctokitOrNull: async () => ({ request }) as OctokitLike,
      })
      await expect(
        provider.push!(binding(), ref, { cycleExternalId }, issue, {
          idempotencyKey: "k",
          by: { kind: "agent" },
        })
      ).rejects.toThrow(/iteration/)
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it.each([
    { errors: [{ message: "Forbidden" }] },
    { data: { repository: { projectV2: null } } },
    { data: { repository: { projectV2: { fields: { pageInfo: { hasNextPage: true } } } } } },
    {
      data: {
        repository: {
          projectV2: { items: { nodes: [{ fieldValues: { pageInfo: { hasNextPage: true } } }] } },
        },
      },
    },
  ])(
    "refuses milestone writes when the configured Project cannot be fully verified",
    async (data) => {
      const execute = jest.fn()
      const provider = createGithubSyncProvider({
        execute: execute as never,
        resolveOctokitOrNull: async () =>
          ({ request: async () => ({ status: 200, headers: {}, data }) }) as OctokitLike,
      })
      await expect(
        provider.push!(binding(), ref, { cycleExternalId: null }, issue, {
          idempotencyKey: "k",
          by: { kind: "agent" },
        })
      ).rejects.toThrow(/iteration/)
      expect(execute).not.toHaveBeenCalled()
    }
  )

  it("still queues milestone changes when the Project confirms no iteration assignment", async () => {
    const execute = jest.fn(async () => ({ id: "job", status: "awaiting_approval" }))
    const provider = createGithubSyncProvider({
      execute: execute as never,
      resolveAccount: async () => ({ id: "acct" }) as never,
      resolveOctokitOrNull: async () =>
        ({
          request: async () => ({
            status: 200,
            headers: {},
            data: {
              data: {
                repository: {
                  projectV2: { items: { nodes: [], pageInfo: { hasNextPage: false } } },
                },
              },
            },
          }),
        }) as OctokitLike,
    })
    await expect(
      provider.push!(
        binding(),
        { ...ref, meta: { cycleKind: "iteration" } },
        { cycleExternalId: milestoneExternalId(3, "acme/one") },
        issue,
        { idempotencyKey: "k", by: { kind: "agent" } }
      )
    ).resolves.toMatchObject({ status: "queued" })
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({ input: { repoFullName: "acme/one", issueNumber: 5, milestone: 3 } })
    )
  })

  it("queues an updateIssue action under the engine's idempotency key", async () => {
    const execute = jest.fn(async () => ({ id: "job-1", status: "awaiting_approval" }))
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => null,
      execute: execute as never,
      resolveAccount: async () => ({ id: "acct", enabled: true }) as never,
    })
    const outcome = await provider.push!(binding(), ref, { title: "T" }, issue, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(outcome).toEqual({ status: "queued", jobId: "job-1" })
    expect(execute).toHaveBeenCalledWith("github-delivery", {
      integrationId: "github",
      accountId: "acct",
      actionId: "updateIssue",
      input: { repoFullName: "acme/one", issueNumber: 5, title: "T" },
      source: "workflow",
      idempotencyKey: "k",
    })
  })

  it("reports applied when the job already completed, and refuses without an account", async () => {
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => null,
      execute: (async () => ({ id: "j", status: "succeeded" })) as never,
      resolveAccount: async () => ({ id: "acct", enabled: true }) as never,
    })
    await expect(
      provider.push!(binding(), ref, { title: "T" }, issue, {
        idempotencyKey: "k",
        by: { kind: "agent" },
      })
    ).resolves.toEqual({ status: "applied" })

    const noAccount = createGithubSyncProvider({
      resolveOctokitOrNull: async () => null,
      execute: jest.fn() as never,
      resolveAccount: async () => null,
    })
    await expect(
      noAccount.push!(binding(), ref, { title: "T" }, issue, {
        idempotencyKey: "k",
        by: { kind: "agent" },
      })
    ).rejects.toMatchObject({ name: "MissingGithubCredentialError" })
  })
})

describe("assignee push", () => {
  const ref: IssueExternalRef = { provider: "github", externalId: "acme/one#5" }

  function setup(remoteAssignees: string[]) {
    const request = jest.fn(async () => ({
      status: 200,
      headers: {},
      data: { assignees: remoteAssignees.map((login) => ({ login })) },
    }))
    const execute = jest.fn(async () => ({ id: "job", status: "awaiting_approval" }))
    const provider = createGithubSyncProvider({
      resolveOctokitOrNull: async () => ({ request }) as unknown as OctokitLike,
      execute: execute as never,
      resolveAccount: async () => ({ id: "acct", enabled: true }) as never,
    })
    return { provider, request, execute }
  }

  it("recognises only an assignee that came from GitHub", () => {
    expect(githubLoginOfAssignee({ assignee: { kind: "human", label: "octo-cat" } })).toBe(
      "octo-cat"
    )
    expect(githubLoginOfAssignee({ assignee: { kind: "human", id: "u1", label: "octocat" } })).toBe(
      undefined
    )
    expect(githubLoginOfAssignee({ assignee: { kind: "agent", id: "a1", label: "Coder" } })).toBe(
      undefined
    )
    expect(githubLoginOfAssignee({ assignee: { kind: "human", label: "Ada Lovelace" } })).toBe(
      undefined
    )
    expect(githubLoginOfAssignee({})).toBe(undefined)
  })

  it("replaces the first assignee and keeps the others", () => {
    expect(nextGithubAssignees(["old", "b", "c"], "new")).toEqual(["new", "b", "c"])
    expect(nextGithubAssignees(["old", "New"], "new")).toEqual(["new"])
    expect(nextGithubAssignees([], "new")).toEqual(["new"])
    expect(nextGithubAssignees(["a", "b"], null)).toEqual([])
  })

  it("sends the full assignee list read from GitHub", async () => {
    const { provider, request, execute } = setup(["alice", "bob"])
    const issue = { id: "i1", assignee: { kind: "human", label: "carol" } } as never
    await provider.push!(binding(), ref, { assignee: "carol" }, issue, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/issues/{issue_number}", {
      owner: "acme",
      repo: "one",
      issue_number: 5,
    })
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({
        input: { repoFullName: "acme/one", issueNumber: 5, assignees: ["carol", "bob"] },
      })
    )
  })

  it("clears GitHub's assignees when the local issue is unassigned", async () => {
    const { provider, execute } = setup(["alice", "bob"])
    await provider.push!(binding(), ref, { assignee: null }, { id: "i1" } as never, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({ input: expect.objectContaining({ assignees: [] }) })
    )
  })

  it("keeps an agent assignee local and sends the rest of the patch", async () => {
    const { provider, request, execute } = setup(["alice"])
    const issue = { id: "i1", assignee: { kind: "agent", id: "a1", label: "Coder" } } as never
    await provider.push!(binding(), ref, { assignee: "Coder", title: "T" }, issue, {
      idempotencyKey: "k",
      by: { kind: "agent" },
    })
    expect(request).not.toHaveBeenCalled()
    expect(execute).toHaveBeenCalledWith(
      "github-delivery",
      expect.objectContaining({ input: { repoFullName: "acme/one", issueNumber: 5, title: "T" } })
    )
  })

  it("sends nothing when the only change was a local-only assignee", async () => {
    const { provider, execute } = setup(["alice"])
    const issue = { id: "i1", assignee: { kind: "agent", id: "a1", label: "Coder" } } as never
    await expect(
      provider.push!(binding(), ref, { assignee: "Coder" }, issue, {
        idempotencyKey: "k",
        by: { kind: "agent" },
      })
    ).resolves.toEqual({ status: "applied" })
    expect(execute).not.toHaveBeenCalled()
  })
})
