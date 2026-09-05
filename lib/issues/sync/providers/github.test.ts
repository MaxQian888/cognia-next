import type { IssueExternalRef, IssueProject } from "@/types/issues"
import type { OctokitLike } from "@/lib/github/issues"
import type { IssueSyncBinding } from "../types"
import {
  createGithubSyncProvider,
  extractIssueMentions,
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
      cycleExternalId: milestoneExternalId(2),
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
        cycleExternalId: "milestone/3",
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
    expect(toUpdateIssueInput("acme/one", 5, { cycleExternalId: "iteration/x" })).toEqual({
      repoFullName: "acme/one",
      issueNumber: 5,
    })
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
                    content: { number: 1 },
                    fieldValues: { nodes: [{ iterationId: "it1", title: "Sprint 1" }] },
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
      milestoneExternalId(9),
    ])
    const iteration = result.cycles?.find((c) => c.kind === "cycle")
    expect(iteration).toMatchObject({ name: "Sprint 1", startsAt: Date.parse("2026-01-01") })
    expect(result.links).toEqual([
      expect.objectContaining({
        provider: "github-pr",
        externalId: "acme/one#20",
        mentionsIdentifiers: ["MERC-4"],
        mentionsExternalIds: ["acme/one#1"],
      }),
    ])
  })

  it("fails the binding, not the run, when no credential resolves", async () => {
    const provider = createGithubSyncProvider({ resolveOctokitOrNull: async () => null })
    await expect(provider.pull(binding(), {})).rejects.toMatchObject({
      name: "MissingGithubCredentialError",
    })
  })
})

describe("push", () => {
  const ref: IssueExternalRef = { provider: "github", externalId: "acme/one#5" }
  const issue = { id: "i1" } as never

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
