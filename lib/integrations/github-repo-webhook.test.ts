jest.mock("@/lib/credentials/keyring-store", () => ({ createKeyringStore: jest.fn() }))
jest.mock("@/lib/db/integrations", () => ({ updateIntegrationAccount: jest.fn() }))
jest.mock("@/lib/network/proxy-fetch", () => ({ proxyFetch: jest.fn() }))
jest.mock("@/lib/plugin/auth/auth-provider-registry", () => ({ getProvider: jest.fn() }))
jest.mock("./action-runner", () => ({ integrationApiBaseUrl: jest.fn() }))

import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import {
  configureGithubRepoWebhook,
  GithubRepoWebhookError,
  repoHookEvents,
  type GithubRepoWebhookDeps,
} from "./github-repo-webhook"

const URL = "https://hooks.example.com/integration/route-1"

function account(over: Partial<IntegrationAccount> = {}): IntegrationAccount {
  return {
    id: "acc",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: "s",
    remoteAccountId: "octocat",
    label: "octocat",
    enabled: true,
    health: "healthy",
    ingressEndpoint: {
      id: "ep",
      accountId: "acc",
      routeId: "route-1",
      secretHandle: "handle-1",
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }
}

function deps(
  responses: Array<{ status: number; data: unknown }>,
  secret: string | null = "shh"
): GithubRepoWebhookDeps & { request: jest.Mock; updateAccount: jest.Mock } {
  const queue = [...responses]
  return {
    request: jest.fn(
      async () => queue.shift() ?? { status: 500, data: null }
    ) as unknown as jest.Mock & GithubRepoWebhookDeps["request"],
    loadSecret: jest.fn(async () => secret),
    updateAccount: jest.fn(async () => undefined) as unknown as jest.Mock &
      GithubRepoWebhookDeps["updateAccount"],
    now: () => Date.parse("2026-09-01T00:00:00.000Z"),
  }
}

describe("repoHookEvents", () => {
  it("maps event types to hook event names and drops App lifecycle events", () => {
    expect(
      repoHookEvents([
        "issues.closed",
        "issues.opened",
        "push.received",
        "pull_request_review_comment.created",
        "installation.created",
        "github_app_authorization.revoked",
      ])
    ).toEqual(["issues", "pull_request_review_comment", "push"])
  })
})

describe("configureGithubRepoWebhook", () => {
  const input = { repoFullName: "acme/app", webhookUrl: URL, eventTypes: ["issues.closed"] }

  it("creates the hook with the endpoint's existing secret", async () => {
    const d = deps([
      { status: 200, data: [] },
      { status: 201, data: { id: 42 } },
    ])
    await expect(configureGithubRepoWebhook({ ...input, account: account() }, d)).resolves.toEqual({
      status: "created",
      hookId: 42,
      events: ["issues"],
    })
    expect(d.loadSecret).toHaveBeenCalledWith("handle-1")
    expect(d.request).toHaveBeenLastCalledWith(expect.anything(), "/repos/acme/app/hooks", {
      method: "POST",
      body: {
        name: "web",
        active: true,
        events: ["issues"],
        config: { url: URL, content_type: "json", insecure_ssl: "0", secret: "shh" },
      },
    })
    expect(d.updateAccount).toHaveBeenCalledWith(
      "github-delivery",
      "acc",
      expect.objectContaining({ status: expect.objectContaining({ code: "webhook_verified" }) })
    )
  })

  it("updates an existing hook for the same URL and keeps its other events", async () => {
    const d = deps([
      {
        status: 200,
        data: [
          { id: 7, events: ["push"], config: { url: "https://other.example.com/x" } },
          { id: 9, events: ["pull_request"], config: { url: URL } },
        ],
      },
      { status: 200, data: { id: 9 } },
    ])
    const result = await configureGithubRepoWebhook({ ...input, account: account() }, d)
    expect(result).toEqual({ status: "updated", hookId: 9, events: ["issues", "pull_request"] })
    expect(d.request).toHaveBeenLastCalledWith(
      expect.anything(),
      "/repos/acme/app/hooks/9",
      expect.objectContaining({ method: "PATCH" })
    )
  })

  it("walks every page of hooks before deciding to create", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      config: { url: `https://x/${i}` },
    }))
    const d = deps([
      { status: 200, data: full },
      { status: 200, data: [{ id: 500, events: [], config: { url: URL } }] },
      { status: 200, data: { id: 500 } },
    ])
    expect((await configureGithubRepoWebhook({ ...input, account: account() }, d)).status).toBe(
      "updated"
    )
    expect(d.request).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "/repos/acme/app/hooks?per_page=100&page=2"
    )
  })

  it("refuses an App account — its App hook already delivers every repository", async () => {
    await expect(
      configureGithubRepoWebhook(
        { ...input, account: account({ providerId: "github-app" }) },
        deps([])
      )
    ).rejects.toMatchObject({ code: "not-pat" })
  })

  it("refuses the loopback listener URL", async () => {
    await expect(
      configureGithubRepoWebhook(
        { ...input, webhookUrl: "http://127.0.0.1:4455/integration/route-1", account: account() },
        deps([])
      )
    ).rejects.toMatchObject({ code: "not-public" })
  })

  it("needs an endpoint and its secret", async () => {
    await expect(
      configureGithubRepoWebhook(
        { ...input, account: account({ ingressEndpoint: undefined }) },
        deps([])
      )
    ).rejects.toMatchObject({ code: "no-endpoint" })
    await expect(
      configureGithubRepoWebhook({ ...input, account: account() }, deps([], null))
    ).rejects.toMatchObject({ code: "no-secret" })
  })

  it("reports a token without hook permission as forbidden", async () => {
    await expect(
      configureGithubRepoWebhook(
        { ...input, account: account() },
        deps([{ status: 404, data: {} }])
      )
    ).rejects.toBeInstanceOf(GithubRepoWebhookError)
    await expect(
      configureGithubRepoWebhook(
        { ...input, account: account() },
        deps([
          { status: 200, data: [] },
          { status: 403, data: {} },
        ])
      )
    ).rejects.toMatchObject({ code: "forbidden" })
  })

  it("reports other failures", async () => {
    await expect(
      configureGithubRepoWebhook(
        { ...input, account: account() },
        deps([
          { status: 200, data: [] },
          { status: 422, data: {} },
        ])
      )
    ).rejects.toMatchObject({ code: "failed" })
  })

  it("skips when only App lifecycle events were selected", async () => {
    const d = deps([])
    await expect(
      configureGithubRepoWebhook(
        { ...input, eventTypes: ["installation.created"], account: account() },
        d
      )
    ).resolves.toEqual({ status: "skipped", reason: "no-repository-events" })
    expect(d.request).not.toHaveBeenCalled()
  })
})
