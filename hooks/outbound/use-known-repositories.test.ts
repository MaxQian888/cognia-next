/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { renderHook, waitFor } from "@testing-library/react"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { repositoryTarget } from "@/lib/policy/action-review/outbound-targets"

import {
  knownRepositoriesOf,
  useKnownRepositories,
  type KnownRepositorySources,
} from "./use-known-repositories"

jest.mock("@/lib/integrations/action-runner", () => ({
  integrationApiBaseUrl: jest.fn(async (account: { authSessionId: string }) =>
    account.authSessionId === "ghe" ? "https://ghe.corp.io/api/v3" : undefined
  ),
}))

const resolveTeamRepo = jest.fn(async (path: string) =>
  path === "/work/tools" ? { fullName: "acme/tools", host: { id: "github.com" } } : null
)
jest.mock("@/lib/ai/agent/team/pr-feedback/resolvers", () => ({
  createResolveTeamRepo: () => resolveTeamRepo,
}))

function sources(extra: Partial<KnownRepositorySources> = {}): KnownRepositorySources {
  return {
    subscriptions: [],
    installations: [],
    jobs: [],
    teamRepositories: [],
    accountHosts: new Map(),
    ...extra,
  }
}

describe("knownRepositoriesOf", () => {
  it("collects every source once, by its newest sighting, newest first", () => {
    const known = knownRepositoriesOf(
      sources({
        subscriptions: [
          {
            accountId: "a",
            resourceKind: "repository",
            resourceId: "Acme/Web",
            updatedAt: "1970-01-01T00:00:00.001Z",
          },
          { accountId: "a", resourceKind: "organization", resourceId: "acme", updatedAt: "x" },
        ],
        installations: [
          {
            config: { repository: "acme/bot" },
            credentialBindings: { github: { integrationAccountId: "a" } },
            updatedAt: 4,
          },
        ],
        jobs: [
          {
            accountId: "a",
            input: { repoFullName: "acme/web" },
            updatedAt: "1970-01-01T00:00:00.005Z",
          },
          { accountId: "a", input: { repoFullName: 42 }, updatedAt: "x" },
        ],
        teamRepositories: [{ fullName: "acme/tools", updatedAt: 2 }],
      })
    )
    expect(known.map((entry) => [entry.name, entry.lastSeenAt])).toEqual([
      ["acme/web", 5],
      ["acme/bot", 4],
      ["acme/tools", 2],
    ])
    expect(known[0].target).toEqual(repositoryTarget("acme/web"))
  })

  it("names each repository on its account's host", () => {
    const known = knownRepositoriesOf(
      sources({
        jobs: [{ accountId: "ghe", input: { repoFullName: "acme/web" }, updatedAt: "x" }],
        accountHosts: new Map([["ghe", "ghe.corp.io"]]),
      })
    )
    expect(known.map((entry) => [entry.target, entry.name])).toEqual([
      [repositoryTarget("ghe.corp.io/acme/web"), "ghe.corp.io/acme/web"],
    ])
  })

  it("keeps to one account when asked, leaving teams out", () => {
    const known = knownRepositoriesOf(
      sources({
        subscriptions: [
          { accountId: "a", resourceKind: "repository", resourceId: "acme/a", updatedAt: "x" },
          { accountId: "b", resourceKind: "repository", resourceId: "acme/b", updatedAt: "x" },
        ],
        installations: [
          {
            config: { repoFullName: "acme/bot" },
            credentialBindings: {
              chat: {},
              github: { integrationAccountId: "b" },
            },
            updatedAt: 1,
          },
        ],
        teamRepositories: [{ fullName: "acme/tools", updatedAt: 2 }],
      }),
      { accountId: "b" }
    )
    expect(known.map((entry) => entry.name).sort()).toEqual(["acme/b", "acme/bot"])
  })
})

describe("useKnownRepositories", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("reads the stored sources, account hosts and stacked teams' checkouts", async () => {
    const db = getDb()
    const now = "2026-10-25T00:00:00.000Z"
    await db.integrationAccounts.bulkPut([
      {
        id: "acct_ghe",
        pluginId: "github-delivery",
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "ghe",
        remoteAccountId: "octo",
        label: "GHE",
        enabled: true,
        health: "unknown",
        createdAt: now,
        updatedAt: now,
      },
    ])
    await db.integrationSubscriptions.put({
      id: "sub_1",
      pluginId: "github-delivery",
      integrationId: "github",
      accountId: "acct_ghe",
      resourceKind: "repository",
      resourceId: "acme/web",
      eventTypes: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    })
    await db.agentTeams.bulkPut([
      {
        id: "team_1",
        updatedAt: 2,
        createdAt: 1,
        config: {
          workingDir: "/work/tools",
          githubDeliveryPolicy: { enabled: true, stackedPullRequests: true },
        },
      },
      { id: "team_2", updatedAt: 3, createdAt: 1, config: { workingDir: "/work/other" } },
    ] as never)

    const { result } = renderHook(() => useKnownRepositories())
    await waitFor(() =>
      expect(result.current.map((entry) => entry.name).sort()).toEqual([
        "acme/tools",
        "ghe.corp.io/acme/web",
      ])
    )
    // Only teams that publish stacks have their checkout read.
    expect(resolveTeamRepo).toHaveBeenCalledTimes(1)
    expect(resolveTeamRepo).toHaveBeenCalledWith("/work/tools")

    const { result: narrowed } = renderHook(() => useKnownRepositories("acct_ghe"))
    await waitFor(() =>
      expect(narrowed.current.map((entry) => entry.name)).toEqual(["ghe.corp.io/acme/web"])
    )
  })
})
