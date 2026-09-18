/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  __resetIntegrationRegistryForTesting,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"
import * as botBinding from "./bot-integration-binding"
import { setIntegrationAuthenticatedRequestExecutorForTesting } from "@/lib/integrations/action-runner"
import { createIntegrationsAPI } from "./integrations-api"

// Mutable namespace seams retain the real implementations unless a boundary test spies on one.
jest.mock("@/lib/db/integrations", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/db/integrations"),
}))
jest.mock("@/lib/integrations/action-runner", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/action-runner"),
}))
jest.mock("@/lib/integrations/ingress-client", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/ingress-client"),
}))
jest.mock("@/lib/integrations/events", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/events"),
}))
jest.mock("@/lib/integrations/migration", () => ({
  __esModule: true,
  ...jest.requireActual("@/lib/integrations/migration"),
}))

jest.mock("./bot-integration-binding", () => ({
  ...jest.requireActual("./bot-integration-binding"),
  resolveBotIntegrationBinding: jest.fn(),
}))

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
  afterEach(() => {
    jest.restoreAllMocks()
    setIntegrationAuthenticatedRequestExecutorForTesting()
  })

  it("allows repository-scoped paginated GET through the bound provider only", async () => {
    const provider = createIntegrationsAPI("example-delivery", () => true)
    const account = await provider.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque",
      remoteAccountId: "one",
      label: "One",
    })
    jest
      .spyOn(botBinding, "resolveBotIntegrationBinding")
      .mockResolvedValue({ account, repository: "owner/repo" } as Awaited<
        ReturnType<typeof botBinding.resolveBotIntegrationBinding>
      >)
    const request = jest
      .fn()
      .mockResolvedValue({ status: 200, headers: { link: "next" }, data: [] })
    setIntegrationAuthenticatedRequestExecutorForTesting(request)
    const api = createIntegrationsAPI("bot", () => true)
    const ref = { runId: "run", slotId: "github" }
    await expect(
      api.authenticatedRequest(ref, "https://api.github.com/repos/owner/repo/issues?page=2", {
        headers: { "if-none-match": "etag" },
      })
    ).resolves.toMatchObject({ headers: { link: "next" } })
    expect(request).toHaveBeenCalledWith("example-delivery", account.id, expect.any(String), {
      headers: { "if-none-match": "etag" },
    })
    for (const url of [
      "https://api.github.com/repos/owner/other/issues",
      "https://evil.test/repos/owner/repo/issues",
      "https://api.github.com/repos/owner/repo/../other/issues",
      "https://api.github.com/repos/owner/repo/%2e%2e%2fother",
      "https://api.github.com/user/repos",
    ]) {
      await expect(api.authenticatedRequest(ref, url)).rejects.toThrow("scope")
    }
    await expect(
      api.authenticatedRequest(ref, "https://api.github.com/repos/owner/repo/issues", {
        method: "POST",
        body: "{}",
      })
    ).rejects.toThrow("read-only")
    await expect(
      api.authenticatedRequest(account.id, "https://api.github.com/repos/owner/repo/issues")
    ).rejects.toThrow("not found")
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("does not expose unrelated subscriptions or resource discovery through a binding", async () => {
    const api = createIntegrationsAPI("example-delivery", () => true)
    const account = await api.createAccount({
      integrationId: "example",
      providerId: "oauth",
      authSessionId: "opaque",
      remoteAccountId: "one",
      label: "One",
    })
    const own = await api.createSubscription({
      integrationId: "example",
      accountId: account.id,
      resourceKind: "repository",
      resourceId: "cognia/cognia-next",
      eventTypes: [],
    })
    await api.createSubscription({
      integrationId: "example",
      accountId: account.id,
      resourceKind: "repository",
      resourceId: "private/other",
      eventTypes: [],
    })
    jest
      .spyOn(botBinding, "resolveBotIntegrationBinding")
      .mockResolvedValue({ account, repository: "cognia/cognia-next" } as Awaited<
        ReturnType<typeof botBinding.resolveBotIntegrationBinding>
      >)
    const bot = createIntegrationsAPI("bot", () => true)
    const ref = { runId: "run", slotId: "github" }
    await expect(bot.listSubscriptions(ref)).resolves.toEqual([own])
    await expect(bot.listResources({ accountId: ref, kind: "repository" })).resolves.toMatchObject({
      items: [{ id: "cognia/cognia-next" }],
    })
    await expect(bot.listResources({ accountId: ref, kind: "issue" })).rejects.toThrow(
      "scoped repository"
    )
    await expect(bot.checkAccountHealth(ref)).resolves.toMatchObject({ health: "healthy" })
  })
})

it("exposes only the bound GitHub actor identity and rejects broader identity routes", async () => {
  const account = { id: "account", pluginId: "github-delivery" }
  jest
    .spyOn(botBinding, "resolveBotIntegrationBinding")
    .mockResolvedValue({ account, repository: "owner/repo" } as never)
  const request = jest.fn().mockResolvedValue({
    status: 200,
    headers: {},
    data: { login: "actor", id: 3, email: "private", plan: { name: "private" } },
  })
  setIntegrationAuthenticatedRequestExecutorForTesting(request)
  const api = createIntegrationsAPI("bot", () => true)
  const ref = { runId: "run", slotId: "github" }
  expect((await api.authenticatedRequest(ref, "https://api.github.com/user")).data).toEqual({
    login: "actor",
    id: 3,
  })
  for (const url of [
    "https://api.github.com/user?extra=true",
    "https://api.github.com/user/repos",
    "https://evil.test/user",
  ])
    await expect(api.authenticatedRequest(ref, url)).rejects.toThrow("scope")
  request.mockResolvedValue({ status: 403, headers: {}, data: null })
  expect((await api.authenticatedRequest(ref, "https://api.github.com/user")).data).toEqual({})
})

it("requires the declared permission before invoking every integration operation", async () => {
  const api = createIntegrationsAPI("denied", () => false)
  for (const method of Object.values(api)) {
    await expect(
      Promise.resolve().then(() => (method as (...args: unknown[]) => unknown)(undefined))
    ).rejects.toThrow("requires the")
  }
})

it("delegates account, publication and recovery operations with the calling plugin's identity", async () => {
  const database = await import("@/lib/db/integrations")
  const actions = await import("@/lib/integrations/action-runner")
  const ingress = await import("@/lib/integrations/ingress-client")
  const events = await import("@/lib/integrations/events")
  const migrations = await import("@/lib/integrations/migration")
  const api = createIntegrationsAPI("owner", () => true)
  try {
    const list = jest.spyOn(database, "listIntegrationAccounts").mockResolvedValue([])
    await api.listAccounts("github")
    expect(list).toHaveBeenCalledWith("owner", "github")
    const update = jest
      .spyOn(database, "updateIntegrationAccount")
      .mockResolvedValue({ id: "account" } as never)
    await api.updateAccount("account", { enabled: false })
    expect(update).toHaveBeenCalledWith("owner", "account", { enabled: false })
    const remove = jest.spyOn(ingress, "deleteIntegrationAccount").mockResolvedValue(undefined)
    await api.removeAccount("account")
    expect(remove).toHaveBeenCalledWith("owner", "account")
    const unsubscribe = jest
      .spyOn(ingress, "deleteIntegrationSubscription")
      .mockResolvedValue(undefined)
    await api.removeSubscription("subscription")
    expect(unsubscribe).toHaveBeenCalledWith("owner", "subscription")
    const publish = jest
      .spyOn(events, "publishIntegrationEvent")
      .mockResolvedValue({ inserted: false } as never)
    const event = { id: "event" } as never
    expect(await api.publishEvent(event)).toEqual({ inserted: false })
    expect(publish).toHaveBeenCalledWith("owner", event)
    const execute = jest
      .spyOn(actions, "executeIntegrationAction")
      .mockResolvedValue({ id: "job" } as never)
    const action = { actionId: "write", accountId: "account", integrationId: "github", input: {} }
    await api.executeAction(action)
    expect(execute).toHaveBeenCalledWith("owner", action)
    const job = jest
      .spyOn(database, "getIntegrationActionJob")
      .mockResolvedValue({ pluginId: "other" } as never)
    expect(await api.getActionJob("job")).toBeUndefined()
    await expect(api.cancelAction("job")).rejects.toThrow("not found")
    job.mockResolvedValue({ pluginId: "owner" } as never)
    expect(await api.getActionJob("job")).toMatchObject({ pluginId: "owner" })
    const cancel = jest
      .spyOn(actions, "cancelIntegrationActionJob")
      .mockResolvedValue({ id: "job" } as never)
    await api.cancelAction("job")
    expect(cancel).toHaveBeenCalledWith("job")
    job.mockResolvedValue({
      pluginId: "provider",
      accountId: "bound",
      botBinding: { pluginId: "owner", runId: "run", slotId: "github" },
    } as never)
    jest
      .mocked(botBinding.resolveBotIntegrationBinding)
      .mockResolvedValue({ account: { id: "bound" } } as never)
    expect(await api.getActionJob("job")).toMatchObject({ pluginId: "provider" })
    await api.cancelAction("job")
    expect(botBinding.resolveBotIntegrationBinding).toHaveBeenCalledWith(
      "owner",
      expect.objectContaining({ runId: "run" })
    )
    const subscriptions = jest.spyOn(database, "listIntegrationSubscriptions").mockResolvedValue([])
    expect(await api.getIngressPublicUrl("subscription")).toBeUndefined()
    subscriptions.mockResolvedValue([{ id: "subscription", accountId: "account" }] as never)
    const endpoint = jest
      .spyOn(database, "getIntegrationIngressEndpoint")
      .mockResolvedValue(undefined)
    expect(await api.getIngressPublicUrl("subscription")).toBeUndefined()
    endpoint.mockResolvedValue({ routeId: "route" } as never)
    const publicUrl = jest
      .spyOn(ingress, "getIntegrationIngressPublicUrl")
      .mockResolvedValue("https://host.test/route")
    expect(await api.getIngressPublicUrl("subscription")).toBe("https://host.test/route")
    expect(publicUrl).toHaveBeenCalledWith("route")
    const deadletters = jest
      .spyOn(ingress, "listIntegrationIngressDeadletters")
      .mockResolvedValue([])
    await api.listIngressDeadletters("account")
    expect(deadletters).toHaveBeenCalledWith("owner", "account")
    const deadletter = jest
      .spyOn(ingress, "getIntegrationIngressDeadletter")
      .mockResolvedValue(undefined)
    await api.getIngressDeadletter("account", "route", "delivery")
    expect(deadletter).toHaveBeenCalledWith("owner", "account", "route", "delivery")
    const replay = jest
      .spyOn(ingress, "requeueIntegrationIngressDeadletter")
      .mockResolvedValue(true)
    await api.requeueIngressDeadletter("account", "route", "delivery")
    expect(replay).toHaveBeenCalledWith("owner", "account", "route", "delivery")
    const migrate = jest
      .spyOn(migrations, "migrateLegacyIntegration")
      .mockResolvedValue({} as never)
    await api.migrateLegacy({} as never)
    expect(migrate).toHaveBeenCalledWith("owner", {})
    const rollback = jest
      .spyOn(migrations, "rollbackIntegrationMigration")
      .mockResolvedValue(undefined)
    await api.rollbackMigration("migration")
    expect(rollback).toHaveBeenCalledWith("owner", "migration")
  } finally {
    jest.restoreAllMocks()
  }
})
