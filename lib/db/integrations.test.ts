/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "./schema"
import {
  appendIntegrationAudit,
  createIntegrationAccount,
  createIntegrationSubscription,
  enqueueIntegrationActionJob,
  getIntegrationActionJob,
  insertIntegrationEvent,
  listIntegrationAccounts,
  listIntegrationSubscriptions,
  updateIntegrationActionJob,
} from "./integrations"

describe("Integration persistence", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("isolates accounts and subscriptions by owning plugin", async () => {
    const github = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-oauth",
      authSessionId: "opaque-gh",
      remoteAccountId: "octocat",
      label: "Octocat",
    })
    await createIntegrationAccount("gitlab-delivery", {
      integrationId: "gitlab",
      providerId: "gitlab-oauth",
      authSessionId: "opaque-gl",
      remoteAccountId: "octocat",
      label: "GitLab Octocat",
    })
    await createIntegrationSubscription("github-delivery", {
      integrationId: "github",
      accountId: github.id,
      resourceKind: "repository",
      resourceId: "cognia/app",
      eventTypes: ["pull_request.updated"],
    })

    await expect(listIntegrationAccounts("github-delivery")).resolves.toHaveLength(1)
    await expect(listIntegrationSubscriptions("github-delivery", github.id)).resolves.toHaveLength(
      1
    )
    await expect(listIntegrationSubscriptions("gitlab-delivery", github.id)).resolves.toHaveLength(
      0
    )
  })

  it("deduplicates normalized deliveries per account", async () => {
    const event = {
      schemaVersion: 1 as const,
      id: "evt-1",
      pluginId: "github-delivery",
      integrationId: "github",
      accountId: "acct-1",
      deliveryId: "delivery-1",
      eventType: "issue.updated",
      occurredAt: "2026-07-28T00:00:00.000Z",
      receivedAt: "2026-07-28T00:00:01.000Z",
      payload: { issue: 42 },
    }

    await expect(insertIntegrationEvent(event)).resolves.toEqual({ inserted: true })
    await expect(insertIntegrationEvent({ ...event, id: "evt-2" })).resolves.toEqual({
      inserted: false,
    })
  })

  it("stores only explicitly approved HTTPS self-hosted origins", async () => {
    const account = await createIntegrationAccount("gitlab-delivery", {
      integrationId: "gitlab",
      providerId: "gitlab-token",
      authSessionId: "opaque",
      remoteAccountId: "self-hosted",
      label: "Company GitLab",
      approvedOrigins: ["https://gitlab.example.test/path"],
    })
    expect(account.approvedOrigins).toEqual(["https://gitlab.example.test"])

    await expect(
      createIntegrationAccount("gitlab-delivery", {
        integrationId: "gitlab",
        providerId: "gitlab-token",
        authSessionId: "opaque-2",
        remoteAccountId: "insecure",
        label: "Insecure GitLab",
        approvedOrigins: ["http://gitlab.example.test"],
      })
    ).rejects.toThrow(/must use HTTPS/)
  })

  it("persists action transitions and audit entries", async () => {
    const job = await enqueueIntegrationActionJob({
      pluginId: "linear-delivery",
      integrationId: "linear",
      accountId: "acct-linear",
      actionId: "issue.update",
      input: { issueId: "ENG-1" },
      status: "awaiting_approval",
      risk: "write",
      attempts: 0,
      maxAttempts: 5,
      source: "workflow",
    })

    await updateIntegrationActionJob(job.id, {
      status: "succeeded",
      attempts: 1,
      output: { ok: true },
    })
    await appendIntegrationAudit({
      pluginId: "linear-delivery",
      integrationId: "linear",
      accountId: "acct-linear",
      kind: "action.issue.update",
      outcome: "succeeded",
    })

    await expect(getIntegrationActionJob(job.id)).resolves.toMatchObject({
      status: "succeeded",
      attempts: 1,
      output: { ok: true },
    })
    await expect(getDb().integrationAudit.count()).resolves.toBe(1)
  })
})
