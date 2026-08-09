/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetIntegrationRegistryForTesting,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"
import { createIntegrationsAPI } from "./integrations-api"

describe("ctx.integrations", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          resourceProvider: { handler: "listResources", kinds: ["issue", "repository"] },
          healthProvider: { handler: "checkHealth" },
          eventTypes: [],
          inboxProjections: [
            {
              id: "issue-thread",
              label: "Issue thread",
              eventTypes: ["issue.updated"],
              threadKeyPointer: "/issue/id",
              titlePointer: "/issue/title",
              bodyPointer: "/issue/body",
            },
          ],
          actions: [],
        },
      ],
      handlers: {},
      resourceProviders: {
        example: async (query) => ({
          items: [{ kind: query.kind, id: "cognia/cognia-next", name: "cognia-next" }],
          syncedAt: "2026-08-09T00:00:00.000Z",
        }),
      },
      accountStatusProviders: {
        example: async () => ({
          health: "healthy",
          checkedAt: "2026-08-09T00:00:00.000Z",
          grantedPermissions: ["issues:write"],
          requiredPermissions: ["issues:write"],
        }),
      },
    })
  })

  it("keeps account and subscription mutations behind integrations:manage", async () => {
    const readOnly = createIntegrationsAPI(
      "example-delivery",
      (permission) => permission === "integrations:read"
    )
    await expect(
      readOnly.createAccount({
        integrationId: "example",
        providerId: "oauth",
        authSessionId: "opaque",
        remoteAccountId: "one",
        label: "One",
      })
    ).rejects.toThrow('requires the "integrations:manage" permission')
  })

  it("manages only the calling plugin's accounts through opaque handles", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })
    const subscription = await api.createSubscription({
      integrationId: "example",
      accountId: account.id,
      eventTypes: ["issue.updated"],
    })

    expect(account.authSessionId).toBe("opaque-session-id")
    await expect(api.listAccounts()).resolves.toEqual([account])
    await expect(api.listSubscriptions()).resolves.toEqual([subscription])
    expect(api.listDefinitions().map((definition) => definition.id)).toEqual(["example"])
  })

  it("discovers resources and persists normalized account health", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })

    await expect(
      api.listResources({ accountId: account.id, kind: "repository", query: "cognia" })
    ).resolves.toEqual({
      items: [{ kind: "repository", id: "cognia/cognia-next", name: "cognia-next" }],
      syncedAt: "2026-08-09T00:00:00.000Z",
    })
    await expect(api.checkAccountHealth(account.id)).resolves.toMatchObject({
      health: "healthy",
      grantedPermissions: ["issues:write"],
    })
    await expect(api.listAccounts()).resolves.toEqual([
      expect.objectContaining({
        id: account.id,
        health: "healthy",
        status: expect.objectContaining({ checkedAt: "2026-08-09T00:00:00.000Z" }),
      }),
    ])
  })

  it("rejects an undeclared Inbox projection", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque-session-id",
      remoteAccountId: "one",
      label: "One",
    })

    await expect(
      api.createSubscription({
        integrationId: "example",
        accountId: account.id,
        eventTypes: ["issue.updated"],
        inboxProjectionId: "missing",
      })
    ).rejects.toThrow("Inbox projection")
  })

  it("keeps ingress recovery behind read and manage permissions", async () => {
    const readOnly = createIntegrationsAPI(
      "example-delivery",
      (permission) => permission === "integrations:read"
    )
    await expect(readOnly.listIngressDeadletters("account-1")).resolves.toEqual([])
    await expect(
      readOnly.requeueIngressDeadletter("account-1", "route-1", "delivery-1")
    ).rejects.toThrow('requires the "integrations:manage" permission')
  })
})
