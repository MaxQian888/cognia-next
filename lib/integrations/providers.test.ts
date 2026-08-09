/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { createIntegrationAccount, getIntegrationAccount } from "@/lib/db/integrations"
import { __resetIntegrationRegistryForTesting, registerIntegrationDefinitions } from "./registry"
import { checkIntegrationAccountHealth, listIntegrationResources } from "./providers"

describe("Integration resource and health providers", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
  })

  it("bounds discovery pages and persists normalized health state", async () => {
    const resourceProvider = jest.fn(async () => ({
      items: [{ kind: "repository", id: "cognia/app", name: "cognia/app" }],
      syncedAt: "2026-08-09T00:00:00.000Z",
    }))
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: ["repository"],
          resourceProvider: { handler: "resources", kinds: ["repository"] },
          healthProvider: { handler: "health" },
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
      resourceProviders: { github: resourceProvider },
      accountStatusProviders: {
        github: async () => ({
          health: "degraded",
          checkedAt: "2026-08-09T00:00:00.000Z",
          requiredPermissions: ["issues:write", "contents:write", "issues:write"],
          grantedPermissions: ["contents:write"],
        }),
      },
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-app",
      authSessionId: "session",
      remoteAccountId: "42",
      label: "GitHub",
    })

    await listIntegrationResources("github-delivery", {
      accountId: account.id,
      kind: "repository",
      limit: 1000,
    })
    expect(resourceProvider).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
      expect.any(Object)
    )

    await checkIntegrationAccountHealth("github-delivery", account.id)
    expect(await getIntegrationAccount("github-delivery", account.id)).toMatchObject({
      health: "degraded",
      status: {
        requiredPermissions: ["contents:write", "issues:write"],
        grantedPermissions: ["contents:write"],
      },
    })
  })

  it("rejects missing accounts and unavailable providers", async () => {
    await expect(
      listIntegrationResources("github-delivery", {
        accountId: "missing",
        kind: "repository",
      })
    ).rejects.toThrow("was not found")

    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: ["repository"],
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "session",
      remoteAccountId: "octocat",
      label: "GitHub",
    })

    await expect(
      listIntegrationResources("github-delivery", {
        accountId: account.id,
        kind: "repository",
      })
    ).rejects.toThrow("does not provide resource discovery")
    await expect(checkIntegrationAccountHealth("github-delivery", account.id)).rejects.toThrow(
      "does not provide health checks"
    )
  })

  it("validates kinds, provider output, and lower/default page bounds", async () => {
    const resourceProvider = jest
      .fn()
      .mockResolvedValueOnce({ items: [], syncedAt: "2026-08-09T00:00:00.000Z" })
      .mockResolvedValueOnce({
        items: [{ kind: "installation", id: "42", name: "octocat" }],
        syncedAt: "2026-08-09T00:00:00.000Z",
      })
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: ["repository"],
          resourceProvider: { handler: "resources", kinds: ["repository"] },
          eventTypes: [],
          actions: [],
        },
      ],
      handlers: {},
      resourceProviders: { github: resourceProvider },
    })
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-app",
      authSessionId: "session",
      remoteAccountId: "42",
      label: "GitHub",
    })

    await listIntegrationResources("github-delivery", {
      accountId: account.id,
      kind: "repository",
      limit: -10,
    })
    expect(resourceProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 1 }),
      expect.any(Object)
    )

    await expect(
      listIntegrationResources("github-delivery", {
        accountId: account.id,
        kind: "repository",
      })
    ).rejects.toThrow("unexpected resource kind")
    expect(resourceProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ limit: 50 }),
      expect.any(Object)
    )

    await expect(
      listIntegrationResources("github-delivery", {
        accountId: account.id,
        kind: "installation",
      })
    ).rejects.toThrow('resource kind "installation" is not discoverable')
  })
})
