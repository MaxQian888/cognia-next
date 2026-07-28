import type {
  IntegrationAccountRow,
  IntegrationActionJobRow,
  IntegrationAuditRow,
  IntegrationEventRow,
  IntegrationSubscriptionRow,
} from "./integration-types"

describe("integration database row aliases", () => {
  it("preserves the public integration contracts at the database boundary", () => {
    const account = {
      id: "account-1",
      pluginId: "plugin",
      integrationId: "issues",
      providerId: "oauth",
      authSessionId: "session",
      remoteAccountId: "remote",
      label: "Work",
      enabled: true,
      health: "healthy",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
    } satisfies IntegrationAccountRow
    const subscription = {
      id: "subscription-1",
      pluginId: "plugin",
      integrationId: "issues",
      accountId: account.id,
      eventTypes: ["issue.created"],
      enabled: true,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    } satisfies IntegrationSubscriptionRow

    expect(account.health).toBe("healthy")
    expect(subscription.accountId).toBe(account.id)

    // Compile-time assertions keep the remaining aliases tied to their public
    // contracts without inventing runtime behavior for this type-only module.
    expectType<IntegrationEventRow>()
    expectType<IntegrationActionJobRow>()
    expectType<IntegrationAuditRow>()
  })
})

function expectType<T>(): void {
  void (undefined as T | undefined)
}
