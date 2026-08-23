/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  authenticateWorkflowAppApiKey,
  createWorkflowAppApiKey,
  revokeWorkflowAppApiKey,
} from "./api-key-service"

jest.setTimeout(20_000)

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  await getDb().workflowApps.add({
    id: "app_1",
    accountId: "acct_a",
    workflowId: "workflow_1",
    kind: "workflow",
    slug: "review",
    draft: {} as never,
    draftRevision: 1,
    currentReleaseId: "release_1",
    publicationRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  })
})

afterEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("returns a secret once and persists only its hash and prefix", async () => {
  const created = await createWorkflowAppApiKey({
    accountId: "acct_a",
    appId: "app_1",
    name: "Dify migration",
    scopes: ["workflow:run", "workflow:run", "conversation:read"],
    expiresAt: 10_000,
    now: 1_000,
  })
  expect(created.secret).toMatch(/^cog_app_/)
  expect(created.key.scopes).toEqual(["workflow:run", "conversation:read"])
  expect(JSON.stringify(await getDb().workflowAppApiKeys.get(created.key.id))).not.toContain(
    created.secret
  )
  await expect(
    authenticateWorkflowAppApiKey(created.secret, "workflow:run", 2_000)
  ).resolves.toMatchObject({ accountId: "acct_a", appId: "app_1", appSlug: "review" })
  await expect(
    authenticateWorkflowAppApiKey(created.secret, "feedback:write", 2_000)
  ).rejects.toMatchObject({ code: "scope_denied" })
})

it("rejects expired and revoked keys", async () => {
  const expired = await createWorkflowAppApiKey({
    accountId: "acct_a",
    appId: "app_1",
    name: "Short",
    scopes: ["chat:write"],
    expiresAt: 2_000,
    now: 1_000,
  })
  await expect(
    authenticateWorkflowAppApiKey(expired.secret, "chat:write", 2_000)
  ).rejects.toMatchObject({ code: "invalid_key" })

  const revoked = await createWorkflowAppApiKey({
    accountId: "acct_a",
    appId: "app_1",
    name: "Revoked",
    scopes: ["chat:write"],
    now: 1_000,
  })
  await revokeWorkflowAppApiKey({ accountId: "acct_a", keyId: revoked.key.id, now: 1_500 })
  await expect(
    authenticateWorkflowAppApiKey(revoked.secret, "chat:write", 1_600)
  ).rejects.toMatchObject({ code: "invalid_key" })
})

it("stamps the published MCP revocation epoch and rejects MCP keys while disabled", async () => {
  await expect(
    createWorkflowAppApiKey({
      accountId: "acct_a",
      appId: "app_1",
      name: "MCP disabled",
      scopes: ["mcp:invoke"],
      now: 1_000,
    })
  ).rejects.toMatchObject({ code: "mcp_disabled" })

  await getDb().workflowAppReleases.put({
    id: "release_1",
    appId: "app_1",
    accountId: "acct_a",
    snapshot: { mcp: { enabled: true, tokenVersion: 7 } },
  } as never)
  const created = await createWorkflowAppApiKey({
    accountId: "acct_a",
    appId: "app_1",
    name: "MCP",
    scopes: ["mcp:invoke"],
    now: 1_000,
  })
  expect(created.key.mcpTokenVersion).toBe(7)
})
