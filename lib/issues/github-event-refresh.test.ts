jest.mock("@/lib/db/integrations", () => ({ getIntegrationAccount: jest.fn() }))
jest.mock("@/lib/db/github-issue-mirror", () => ({ deleteGithubIssues: jest.fn() }))
jest.mock("@/lib/integrations/action-runner", () => ({ integrationApiBaseUrl: jest.fn() }))
jest.mock("./sync-runner", () => ({
  MissingGithubCredentialError: class extends Error {},
  resolveWorkspaceGithubBindings: jest.fn(),
}))
jest.mock("./github-sync", () => ({ syncRepoIssues: jest.fn() }))
jest.mock("@/lib/ai/agent/team/pr-feedback/resolvers", () => ({
  createResolveOctokit: () => async () => null,
}))
jest.mock("./sync/registry", () => ({ getIssueSyncRegistry: jest.fn() }))
jest.mock("./sync/engine", () => ({ reconcileBinding: jest.fn() }))
jest.mock("./sync/runner", () => ({ resolveWorkspaceSyncBindings: jest.fn() }))
jest.mock("./sync/providers/github", () => ({ GITHUB_SYNC_PROVIDER_ID: "github" }))

import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"
import type { IssueSyncBinding } from "./sync/types"
import {
  GITHUB_EVENT_REFRESH_DEBOUNCE_MS,
  GithubEventIssueRefresher,
  type GithubEventRefreshDeps,
} from "./github-event-refresh"

function event(over: Partial<IntegrationEventEnvelope> = {}): IntegrationEventEnvelope {
  return {
    schemaVersion: 1,
    id: "d1:issues.closed",
    pluginId: "github-delivery",
    integrationId: "github",
    accountId: "acc",
    deliveryId: "d1",
    eventType: "issues.closed",
    resource: { kind: "repository", id: "acme/app" },
    occurredAt: "2026-09-01T00:00:00.000Z",
    receivedAt: "2026-09-01T00:00:01.000Z",
    payload: { action: "closed", issue: { number: 7 } },
    ...over,
  }
}

function setup(over: Partial<GithubEventRefreshDeps> = {}) {
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const deps: GithubEventRefreshDeps = {
    accountHostId: jest.fn(async () => "github.com"),
    mirrorBindings: jest.fn(async () => [{ repoFullName: "acme/app", issueProjectId: "ip1" }]),
    importBindings: jest.fn(async () => [] as IssueSyncBinding[]),
    refreshMirror: jest.fn(async () => undefined),
    reconcileImport: jest.fn(async () => undefined),
    removeFromMirror: jest.fn(async () => undefined),
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
    onError: jest.fn(),
    ...over,
  }
  const fire = async () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.fn()
    // Let the queued refresh chain settle.
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
  }
  return { deps, timers, fire, refresher: new GithubEventIssueRefresher(deps) }
}

describe("GithubEventIssueRefresher.relevant", () => {
  it("accepts issue and issue-comment events on a repository", () => {
    expect(GithubEventIssueRefresher.relevant(event())).toBe(true)
    expect(GithubEventIssueRefresher.relevant(event({ eventType: "issue_comment.created" }))).toBe(
      true
    )
  })

  it("ignores other plugins, other event families and non-repository resources", () => {
    expect(GithubEventIssueRefresher.relevant(event({ pluginId: "other" }))).toBe(false)
    expect(GithubEventIssueRefresher.relevant(event({ eventType: "pull_request.opened" }))).toBe(
      false
    )
    expect(
      GithubEventIssueRefresher.relevant(event({ resource: { kind: "installation", id: "1" } }))
    ).toBe(false)
  })
})

describe("GithubEventIssueRefresher.handle", () => {
  it("refreshes the event's repository once per burst, after the debounce window", async () => {
    const { deps, timers, fire, refresher } = setup()
    await refresher.handle(event())
    await refresher.handle(event({ id: "d2:issues.labeled", eventType: "issues.labeled" }))
    expect(timers.filter((t) => !t.cleared)).toHaveLength(1)
    expect(timers[0].ms).toBe(GITHUB_EVENT_REFRESH_DEBOUNCE_MS)
    expect(refresher.pending()).toEqual(["acme/app"])
    await fire()
    expect(deps.refreshMirror).toHaveBeenCalledTimes(1)
    expect(deps.refreshMirror).toHaveBeenCalledWith({
      repoFullName: "acme/app",
      issueProjectId: "ip1",
    })
    expect(refresher.pending()).toEqual([])
  })

  it("reconciles an import-mode binding of the same repository", async () => {
    const binding = { providerId: "github", key: "Acme/App" } as IssueSyncBinding
    const { deps, fire, refresher } = setup({
      mirrorBindings: jest.fn(async () => []),
      importBindings: jest.fn(async () => [binding, { ...binding, key: "acme/other" }]),
    })
    await refresher.handle(event())
    await fire()
    expect(deps.reconcileImport).toHaveBeenCalledTimes(1)
    expect(deps.reconcileImport).toHaveBeenCalledWith(binding)
  })

  it("removes a transferred issue from the mirror straight away", async () => {
    const { deps, refresher } = setup({
      mirrorBindings: jest.fn(async () => [{ repoFullName: "Acme/App", issueProjectId: "ip1" }]),
    })
    await refresher.handle(event({ eventType: "issues.transferred" }))
    expect(deps.removeFromMirror).toHaveBeenCalledWith("Acme/App", [7])
  })

  it("does not touch the mirror for a departed issue of an unbound repository", async () => {
    const { deps, refresher } = setup({ mirrorBindings: jest.fn(async () => []) })
    await refresher.handle(event({ eventType: "issues.deleted" }))
    expect(deps.removeFromMirror).not.toHaveBeenCalled()
  })

  it("ignores events from a GitHub Enterprise account — bindings name github.com", async () => {
    const { deps, timers, refresher } = setup({
      accountHostId: jest.fn(async () => "ghe.acme.io"),
    })
    await refresher.handle(event({ eventType: "issues.transferred" }))
    expect(timers).toHaveLength(0)
    expect(deps.removeFromMirror).not.toHaveBeenCalled()
  })

  it("reports a failed refresh instead of throwing", async () => {
    const { deps, fire, refresher } = setup({
      refreshMirror: jest.fn(async () => {
        throw new Error("401")
      }),
    })
    await refresher.handle(event())
    await fire()
    expect(deps.onError).toHaveBeenCalledWith("acme/app", expect.any(Error))
  })

  it("reports a failure resolving the account instead of throwing", async () => {
    const { deps, refresher } = setup({
      accountHostId: jest.fn(async () => {
        throw new Error("db closed")
      }),
    })
    await expect(refresher.handle(event())).resolves.toBeUndefined()
    expect(deps.onError).toHaveBeenCalledWith("acme/app", expect.any(Error))
  })

  it("ignores irrelevant events entirely", async () => {
    const { deps, timers, refresher } = setup()
    await refresher.handle(event({ eventType: "pull_request.opened" }))
    expect(timers).toHaveLength(0)
    expect(deps.accountHostId).not.toHaveBeenCalled()
  })
})
