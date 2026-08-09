/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createIntegrationAccount, createIntegrationSubscription } from "@/lib/db/integrations"
import { __resetAuthRegistryForTesting, getSession } from "@/lib/plugin/auth/auth-provider-registry"
import { registerGithubIntegrationAuthProviders } from "./github-auth"
import { __resetIntegrationRegistryForTesting, registerIntegrationDefinitions } from "./registry"
import { publishIntegrationEvent } from "./events"
import { approveIntegrationActionJob, executeIntegrationAction } from "./action-runner"
import * as github from "@/plugins/github-delivery/src/index"

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: () => [],
}))
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: jest.fn(),
}))

describe("GitHub Marketplace vertical", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetAuthRegistryForTesting()
    __resetIntegrationRegistryForTesting()
  })

  it("connects an App, receives an Inbox event, and writes back after approval", async () => {
    const secrets = new Map<string, string>()
    const fetchMock = jest.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "installation-token",
            expires_at: "2026-08-09T02:00:00.000Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
      }
      return new Response(JSON.stringify({ id: 9001 }), {
        status: 201,
        headers: { "content-type": "application/json", "x-github-request-id": "request-1" },
      })
    })
    const fetch = fetchMock as unknown as typeof globalThis.fetch
    const originalFetch = global.fetch
    global.fetch = fetch
    const disposeAuth = registerGithubIntegrationAuthProviders({
      store: {
        save: async (key, value) => void secrets.set(key, value),
        load: async (key) => secrets.get(key) ?? null,
        delete: async (key) => void secrets.delete(key),
      },
      fetch,
      now: () => Date.parse("2026-08-09T01:00:00.000Z"),
      createAppJwt: async () => "app-jwt",
      listAccountSessionIds: async () => [],
    })
    const handlerNames = github.githubIntegration.actions.map((action) => action.handler)
    registerIntegrationDefinitions({
      pluginId: github.manifest.id,
      definitions: [github.githubIntegration],
      handlers: Object.fromEntries(
        github.githubIntegration.actions.map((action) => [
          `github:${action.id}`,
          github[action.handler as keyof typeof github],
        ])
      ) as never,
      normalizers: { github: github.normalizeGithub },
      resourceProviders: { github: github.listGithubResources },
      accountStatusProviders: { github: github.checkGithubHealth },
    })
    expect(handlerNames).toHaveLength(13)

    try {
      const auth = await getSession(
        "github-app",
        github.githubIntegration.authStrategies[0].scopes ?? [],
        {
          createIfNone: true,
          forceNewSession: true,
          configuration: {
            appId: 1,
            installationId: 42,
            privateKey: "host-private-key",
            accountLabel: "cognia",
          },
        }
      )
      const account = await createIntegrationAccount("github-delivery", {
        integrationId: "github",
        providerId: "github-app",
        authSessionId: auth!.id,
        remoteAccountId: "42",
        label: "cognia",
      })
      await createIntegrationSubscription("github-delivery", {
        integrationId: "github",
        accountId: account.id,
        resourceKind: "repository",
        resourceId: "cognia/app",
        eventTypes: ["issues.opened"],
        inboxProjectionId: "issue-thread",
      })
      const normalized = github.normalizeGithub(
        {
          routeId: "route-1",
          deliveryId: "delivery-1",
          eventType: "issues",
          headers: {},
          receivedAt: "2026-08-09T01:00:00.000Z",
          body: JSON.stringify({
            action: "opened",
            repository: { full_name: "cognia/app" },
            issue: { number: 7, title: "Fix setup", body: null },
          }),
        },
        { pluginId: "github-delivery", integrationId: "github", accountId: account.id }
      )
      await expect(publishIntegrationEvent("github-delivery", normalized)).resolves.toMatchObject({
        inserted: true,
        inboxProjections: 1,
      })

      const awaiting = await executeIntegrationAction("github-delivery", {
        integrationId: "github",
        accountId: account.id,
        actionId: "commentIssue",
        input: { repoFullName: "cognia/app", issueNumber: 7, body: "Working on it" },
        idempotencyKey: "delivery-1:comment",
      })
      expect(awaiting.status).toBe("awaiting_approval")
      const completed = await approveIntegrationActionJob(awaiting.id)
      if (completed.status !== "succeeded") throw new Error(completed.error)
      expect(completed).toMatchObject({
        status: "succeeded",
        output: { id: 9001 },
      })
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "https://api.github.com/repos/cognia/app/issues/7/comments"
      )
      expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST")
      const writeHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers)
      expect(writeHeaders.get("authorization")).toBe("Bearer installation-token")
      expect(JSON.stringify(await getDb().integrationAccounts.get(account.id))).not.toContain(
        "host-private-key"
      )
    } finally {
      global.fetch = originalFetch
      disposeAuth()
    }
  })
})
