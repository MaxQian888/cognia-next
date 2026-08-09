/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createIntegrationAccount,
  createIntegrationSubscription,
  getIntegrationAccount,
  listIntegrationSubscriptions,
} from "@/lib/db/integrations"
import type { IntegrationEventEnvelope } from "@/types/plugin/plugin-integration"
import { reconcileGithubLifecycle } from "./github-lifecycle"

describe("reconcileGithubLifecycle", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  async function fixture() {
    const account = await createIntegrationAccount("github-delivery", {
      integrationId: "github",
      providerId: "github-app",
      authSessionId: "session-1",
      remoteAccountId: "42",
      label: "GitHub installation",
    })
    await createIntegrationSubscription("github-delivery", {
      integrationId: "github",
      accountId: account.id,
      resourceKind: "repository",
      resourceId: "cognia/private",
      eventTypes: ["issues.opened"],
    })
    return account
  }

  function event(
    accountId: string,
    eventType: string,
    payload: Record<string, unknown> = {}
  ): IntegrationEventEnvelope {
    return {
      schemaVersion: 1,
      id: `delivery:${eventType}`,
      pluginId: "github-delivery",
      integrationId: "github",
      accountId,
      deliveryId: "delivery",
      eventType,
      occurredAt: "2026-08-09T00:00:00.000Z",
      receivedAt: "2026-08-09T00:00:01.000Z",
      payload,
    }
  }

  it("marks a suspended installation unhealthy and preserves disabled subscriptions", async () => {
    const account = await fixture()
    await reconcileGithubLifecycle(event(account.id, "installation.suspend"))

    expect(await getIntegrationAccount("github-delivery", account.id)).toMatchObject({
      health: "degraded",
      status: { code: "installation_suspended", recoveryAction: "reconnect" },
    })
    expect(await listIntegrationSubscriptions("github-delivery", account.id)).toEqual([
      expect.objectContaining({ enabled: false, disabledByProvider: true }),
    ])
  })

  it("disables only subscriptions for repositories removed from the installation", async () => {
    const account = await fixture()
    await reconcileGithubLifecycle(
      event(account.id, "installation_repositories.removed", {
        repositories_removed: [{ full_name: "cognia/private" }],
      })
    )

    expect(await listIntegrationSubscriptions("github-delivery", account.id)).toEqual([
      expect.objectContaining({
        resourceId: "cognia/private",
        enabled: false,
        disabledReason: "repository_removed",
      }),
    ])
  })

  it("re-enables provider-disabled subscriptions after installation recovery", async () => {
    const account = await fixture()
    await reconcileGithubLifecycle(event(account.id, "installation.suspend"))
    await reconcileGithubLifecycle(event(account.id, "installation.unsuspend"))

    expect(await getIntegrationAccount("github-delivery", account.id)).toMatchObject({
      health: "healthy",
    })
    expect(await listIntegrationSubscriptions("github-delivery", account.id)).toEqual([
      expect.objectContaining({ enabled: true, disabledByProvider: false }),
    ])
  })
})
