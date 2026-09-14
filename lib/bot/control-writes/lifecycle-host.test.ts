/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { registerBot, __resetBotsForTesting } from "@/lib/plugin/registries/bot-registry"
import {
  registerIntegrationDefinitions,
  __resetIntegrationRegistryForTesting,
} from "@/lib/integrations/registry"
import { __setBotWriteRouteDepsForTests } from "./route"
import { mutateBotInstallationOnHost, readBotConsoleOnHost } from "./lifecycle-host"

jest.mock("@/lib/bot/runtime/run", () => {
  const actual = jest.requireActual("@/lib/bot/runtime/run")
  return { ...actual, cancelLiveBotInstallation: jest.fn(actual.cancelLiveBotInstallation) }
})

let restore: () => void
const operationId = "123e4567-e89b-42d3-a456-426614174000"
const input = {
  operation: "install",
  operationId,
  definitionId: "bot:monitor",
  version: "1.0.0",
  scope: { kind: "account" },
}
beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBotsForTesting()
  __resetIntegrationRegistryForTesting()
  restore = __setBotWriteRouteDepsForTests({
    isRemoteHostActive: () => false,
    hasLocalDatabase: () => true,
  })
  registerBot(
    "monitor",
    {
      id: "bot:monitor",
      handler: async () => ({}),
      definition: {
        id: "monitor",
        name: "Monitor",
        version: "1.0.0",
        executor: "handler",
        triggers: [{ id: "manual", kind: "manual" }],
        requires: {
          credentials: [{ id: "github", label: "GitHub", integration: "github", strategy: "pat" }],
        },
        configSchema: {
          type: "object",
          properties: { repository: { type: "string", default: "NJUPT-SAST/sast-approval-next" } },
          required: ["repository"],
          additionalProperties: false,
        },
      },
    },
    { pluginId: "bot" }
  )
})
afterEach(() => restore())

it("requires an explicit valid host grant and preserves unrelated installation ceilings", async () => {
  const installed = await mutateBotInstallationOnHost(input)
  await getDb().botInstallations.update(installed.id, {
    status: "enabled",
    credentialBindings: { github: { integrationAccountId: "fixture-account" } },
    policyGrant: { maxConcurrentRuns: 1, maxRunDurationMs: 60_000 },
  })
  const runtime = await import("@/lib/bot/runtime/run")
  const cancel = jest.mocked(runtime.cancelLiveBotInstallation)
  cancel.mockClear()
  const update = { operation: "config", operationId, installationId: installed.id, config: {} }
  await mutateBotInstallationOnHost(update)
  expect((await getDb().botInstallations.get(installed.id))?.policyGrant).toEqual({
    maxConcurrentRuns: 1,
    maxRunDurationMs: 60_000,
  })
  const grant = {
    maxAuthority: "bypassPermissions",
    maxAutonomy: "autopilot",
    requireApprovalForWrites: false,
  }
  await mutateBotInstallationOnHost({ ...update, policyGrant: grant })
  expect((await getDb().botInstallations.get(installed.id))?.status).toBe("enabled")
  expect(cancel).not.toHaveBeenCalled()
  expect((await getDb().botInstallations.get(installed.id))?.policyGrant).toEqual({
    ...grant,
    maxConcurrentRuns: 1,
    maxRunDurationMs: 60_000,
  })
  await expect(
    mutateBotInstallationOnHost({ ...update, policyGrant: { ...grant, maxConcurrentRuns: 99 } })
  ).rejects.toThrow()
  await expect(
    mutateBotInstallationOnHost({ ...update, policyGrant: { ...grant, maxAuthority: "anything" } })
  ).rejects.toThrow()
  const consoleResult = await readBotConsoleOnHost({ view: "installations" })
  expect(consoleResult).toMatchObject({ rows: [{ policyGrant: grant }] })
  await mutateBotInstallationOnHost({
    ...update,
    policyGrant: {
      maxAuthority: "acceptEdits",
      maxAutonomy: "confirm",
      requireApprovalForWrites: true,
    },
  })
  expect(cancel).toHaveBeenCalledWith(installed.id)
  for (const narrowed of [
    { ...grant, maxAutonomy: "confirm" },
    { ...grant, requireApprovalForWrites: true },
  ]) {
    await mutateBotInstallationOnHost({ ...update, policyGrant: grant })
    cancel.mockClear()
    await mutateBotInstallationOnHost({ ...update, policyGrant: narrowed })
    expect(cancel).toHaveBeenCalledWith(installed.id)
  }
})

it("installs the host catalog default once and remains needs_setup without credentials", async () => {
  const first = await mutateBotInstallationOnHost(input)
  expect(first).toMatchObject({
    id: `boti_${operationId}`,
    status: "needs_setup",
    credentialBindings: {},
    config: {},
  })
  expect(await mutateBotInstallationOnHost(input)).toEqual(first)
  expect(await getDb().botInstallations.count()).toBe(1)
  expect((await getDb().botInstallations.get(first.id))?.config.repository).toBe(
    "NJUPT-SAST/sast-approval-next"
  )
  await expect(
    mutateBotInstallationOnHost({ ...input, config: { repository: "other/repo" } })
  ).rejects.toThrow("another definition")
  await expect(mutateBotInstallationOnHost({ ...input, version: "2" })).rejects.toThrow("changed")
  await expect(mutateBotInstallationOnHost({ ...input, slots: [] })).rejects.toThrow()
})
it("returns host form values but never auth session handles or runtime functions", async () => {
  const installed = await mutateBotInstallationOnHost(input)
  await getDb().botInstallations.update(installed.id, {
    credentialBindings: { github: { integrationAccountId: "account", authSessionId: "SECRET" } },
  })
  const result = await readBotConsoleOnHost({ view: "installations" })
  expect(result).toMatchObject({
    rows: [
      {
        config: { repository: "NJUPT-SAST/sast-approval-next" },
        credentials: [{ integrationAccountId: "account" }],
      },
    ],
  })
  expect(JSON.stringify(result)).not.toContain("SECRET")
  expect(JSON.stringify(await readBotConsoleOnHost({ view: "catalog" }))).not.toContain(
    '"handler":'
  )
})
it("validates config and credential slot/account/strategy before using existing lifecycle writes", async () => {
  const installed = await mutateBotInstallationOnHost(input)
  const next = { operationId, installationId: installed.id }
  await expect(
    mutateBotInstallationOnHost({ ...next, operation: "config", config: { repository: 4 } })
  ).rejects.toThrow("configuration")
  await mutateBotInstallationOnHost({
    ...next,
    operation: "config",
    config: { repository: "owner/repo" },
  })
  await expect(
    mutateBotInstallationOnHost({
      ...next,
      operation: "bind",
      slotId: "other",
      binding: { integrationAccountId: "account" },
    })
  ).rejects.toThrow("declared")
  await expect(
    mutateBotInstallationOnHost({
      ...next,
      operation: "bind",
      slotId: "github",
      binding: { authSessionId: "secret" },
    })
  ).rejects.toThrow()
  await getDb().integrationAccounts.put({
    id: "account",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "github-pat",
    authSessionId: "SECRET",
    remoteAccountId: "owner",
    label: "GitHub",
    enabled: true,
    health: "healthy",
    createdAt: "1",
    updatedAt: "1",
  })
  registerIntegrationDefinitions({
    pluginId: "github-delivery",
    definitions: [
      {
        id: "github",
        label: "GitHub",
        authStrategies: [
          { id: "pat", label: "PAT", providerId: "github-pat", type: "personal-access-token" },
        ],
        resourceKinds: [],
        eventTypes: [],
        actions: [],
      },
    ],
    handlers: {},
  })
  expect(
    await mutateBotInstallationOnHost({
      ...next,
      operation: "bind",
      slotId: "github",
      binding: { integrationAccountId: "account" },
    })
  ).toMatchObject({ status: "enabled", credentialBindings: {} })
  expect(JSON.stringify(await readBotConsoleOnHost({ view: "credentials" }))).not.toContain(
    "SECRET"
  )
  expect(
    await mutateBotInstallationOnHost({ ...next, operation: "set_enabled", enabled: false })
  ).toMatchObject({ status: "disabled" })
  await mutateBotInstallationOnHost({ ...next, operation: "uninstall" })
  expect(await mutateBotInstallationOnHost({ ...next, operation: "uninstall" })).toMatchObject({
    removed: true,
  })
})

it("refuses a workspace scope that exists only on the requesting client", async () => {
  await expect(
    mutateBotInstallationOnHost({
      ...input,
      scope: { kind: "workspace", workspaceId: "client-project" },
    })
  ).rejects.toThrow("scope does not exist")
})

it("rejects invalid initial bindings, incomplete scope, and missing host-owned installations", async () => {
  await expect(mutateBotInstallationOnHost({ ...input, definitionId: "missing" })).rejects.toThrow(
    "missing or changed"
  )
  await expect(
    mutateBotInstallationOnHost({ ...input, scope: { kind: "project" } })
  ).rejects.toThrow("incomplete")
  await expect(
    mutateBotInstallationOnHost({
      ...input,
      credentialBindings: { github: { integrationAccountId: "missing-account" } },
    })
  ).rejects.toThrow("account does not match")
  expect(await getDb().botInstallations.count()).toBe(0)
  await expect(
    mutateBotInstallationOnHost({
      operationId,
      operation: "set_enabled",
      installationId: "missing",
      enabled: true,
    })
  ).rejects.toThrow("not owned")
})
it("clears an approved slot without promoting setup and rejects adapters and strategies that do not match", async () => {
  const installed = await mutateBotInstallationOnHost(input)
  const next = { operationId, installationId: installed.id, operation: "bind", slotId: "github" }
  expect(await mutateBotInstallationOnHost({ ...next, binding: null })).toMatchObject({
    status: "needs_setup",
  })
  await expect(
    mutateBotInstallationOnHost({ ...next, binding: { adapterId: "missing-adapter" } })
  ).rejects.toThrow("adapter does not match")
  await getDb().integrationAccounts.put({
    id: "account",
    pluginId: "github-delivery",
    integrationId: "github",
    providerId: "different-strategy",
    authSessionId: "SECRET",
    remoteAccountId: "owner",
    label: "GitHub",
    enabled: true,
    health: "healthy",
    createdAt: "1",
    updatedAt: "1",
  })
  registerIntegrationDefinitions({
    pluginId: "github-delivery",
    definitions: [
      {
        id: "github",
        label: "GitHub",
        authStrategies: [
          { id: "pat", label: "PAT", providerId: "github-pat", type: "personal-access-token" },
        ],
        resourceKinds: [],
        eventTypes: [],
        actions: [],
      },
    ],
    handlers: {},
  })
  await expect(
    mutateBotInstallationOnHost({ ...next, binding: { integrationAccountId: "account" } })
  ).rejects.toThrow("strategy does not match")
  __resetBotsForTesting()
  await expect(
    mutateBotInstallationOnHost({
      operationId,
      operation: "config",
      installationId: installed.id,
      config: {},
    })
  ).rejects.toThrow("definition is missing")
})
it("refuses a mutation in a companion process even if it holds installation mirrors", async () => {
  const release = __setBotWriteRouteDepsForTests({ isRemoteHostActive: () => true })
  try {
    await expect(mutateBotInstallationOnHost(input)).rejects.toThrow("owning host")
  } finally {
    release()
  }
})
