/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { WorkflowNodeKind } from "@/types/workflow/visual"
import { migrateLegacyIntegration, rollbackIntegrationMigration } from "./migration"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

it("migrates accounts, subscriptions, and workflow aliases transactionally and idempotently", async () => {
  const db = getDb()
  await db.workflows.add({
    id: "wf-legacy",
    schemaVersion: 2,
    name: "Legacy",
    nodes: [
      {
        id: "trigger",
        type: "trigger.test.legacy" as WorkflowNodeKind,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Legacy trigger", params: {} },
      },
    ],
    edges: [],
    settings: {} as never,
    createdAt: 1,
    updatedAt: 1,
  })
  const plan = {
    id: "github-v4",
    integrationId: "github",
    accounts: [
      {
        id: "github-account",
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "opaque",
        remoteAccountId: "octocat",
        label: "GitHub",
      },
    ],
    subscriptions: [
      {
        id: "github-subscription",
        integrationId: "github",
        accountId: "github-account",
        resourceKind: "repository",
        resourceId: "cognia/cognia-next",
        eventTypes: ["pull_request.opened"],
      },
    ],
    workflowKindAliases: {
      "trigger.test.legacy": "trigger.integration.event",
    },
  }

  await expect(migrateLegacyIntegration("github-delivery", plan)).resolves.toMatchObject({
    migratedAccounts: 1,
    migratedSubscriptions: 1,
    migratedWorkflows: 1,
    alreadyApplied: false,
  })
  await expect(migrateLegacyIntegration("github-delivery", plan)).resolves.toMatchObject({
    alreadyApplied: true,
  })
  expect((await db.workflows.get("wf-legacy"))?.nodes[0].type).toBe("trigger.integration.event")
})

it("restores the original workflow and Integration rows from the transaction backup", async () => {
  const db = getDb()
  await db.workflows.add({
    id: "wf-legacy",
    schemaVersion: 2,
    name: "Legacy",
    nodes: [
      {
        id: "action",
        type: "action.test.legacy" as WorkflowNodeKind,
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Legacy action", params: {} },
      },
    ],
    edges: [],
    settings: {} as never,
    createdAt: 1,
    updatedAt: 1,
  })
  await migrateLegacyIntegration("github-delivery", {
    id: "github-v4",
    integrationId: "github",
    accounts: [
      {
        id: "account",
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "opaque",
        remoteAccountId: "octocat",
        label: "GitHub",
      },
    ],
    subscriptions: [],
    workflowKindAliases: {
      "action.test.legacy": "github-delivery.action.openPr",
    },
  })
  await rollbackIntegrationMigration("github-delivery", "github-v4")
  expect((await db.workflows.get("wf-legacy"))?.nodes[0].type).toBe("action.test.legacy")
  expect(await db.integrationAccounts.count()).toBe(0)
})
