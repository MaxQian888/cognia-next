import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import {
  reconcileGithubAppDeliveries,
  type GithubDeliveryRecoveryDependencies,
} from "./github-delivery-recovery"

function account(providerId: string): IntegrationAccount {
  return {
    id: `account-${providerId}`,
    pluginId: "github-delivery",
    integrationId: "github",
    providerId,
    authSessionId: `session-${providerId}`,
    remoteAccountId: "42",
    label: "GitHub",
    enabled: true,
    health: "healthy",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  }
}

describe("reconcileGithubAppDeliveries", () => {
  it("requests redelivery for recoverable failures and stores a checkpoint", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        headers: { "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1786240000" },
        data: [
          { id: 100, guid: "guid-100", status_code: 502, delivered_at: "2026-08-09T00:01:00Z" },
          { id: 99, guid: "guid-99", status_code: 200, delivered_at: "2026-08-09T00:00:00Z" },
        ],
      })
      .mockResolvedValueOnce({ status: 202, headers: {}, data: {} })
    const updateAccount = jest.fn(async () => undefined)
    const appendAudit = jest.fn(async () => undefined)
    const deps: GithubDeliveryRecoveryDependencies = {
      listAccounts: jest.fn(async () => [account("github-app")]),
      request,
      updateAccount,
      appendAudit,
      now: () => Date.parse("2026-08-09T00:02:00Z"),
    }

    await reconcileGithubAppDeliveries(deps)

    expect(request).toHaveBeenNthCalledWith(
      2,
      "session-github-app",
      "/app/hook/deliveries/100/attempts",
      { method: "POST" }
    )
    expect(updateAccount).toHaveBeenCalledWith(
      "github-delivery",
      "account-github-app",
      expect.objectContaining({
        status: expect.objectContaining({
          deliveryRecovery: {
            lastCheckedAt: "2026-08-09T00:02:00.000Z",
            lastDeliveryId: "100",
            pendingRedeliveryIds: [],
          },
        }),
      })
    )
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "github.delivery.redelivery", outcome: "succeeded" })
    )
  })

  it("continues pagination until the checkpoint and does not redeliver successful events", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 300 - index,
      status_code: index === 0 ? 503 : 200,
    }))
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: {}, data: firstPage })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        data: [
          { id: 200, status_code: 200 },
          { id: 199, status_code: 502 },
        ],
      })
      .mockResolvedValueOnce({ status: 202, headers: {}, data: {} })
    const appAccount = account("github-app")
    appAccount.status = {
      health: "healthy",
      checkedAt: "2026-08-08T00:00:00.000Z",
      deliveryRecovery: {
        lastCheckedAt: "2026-08-08T00:00:00.000Z",
        lastDeliveryId: "200",
      },
    }
    const deps: GithubDeliveryRecoveryDependencies = {
      listAccounts: jest.fn(async () => [appAccount]),
      request,
      updateAccount: jest.fn(async () => undefined),
      appendAudit: jest.fn(async () => undefined),
      now: () => Date.parse("2026-08-09T00:02:00Z"),
    }

    await reconcileGithubAppDeliveries(deps)

    expect(request).toHaveBeenNthCalledWith(
      2,
      "session-github-app",
      "/app/hook/deliveries?per_page=100&page=2"
    )
    expect(request).toHaveBeenCalledTimes(3)
    expect(request).toHaveBeenLastCalledWith(
      "session-github-app",
      "/app/hook/deliveries/300/attempts",
      { method: "POST" }
    )
  })

  it("persists failed redeliveries and retries each delivery only once per run", async () => {
    const appAccount = account("github-app")
    appAccount.status = {
      health: "degraded",
      checkedAt: "2026-08-08T00:00:00.000Z",
      deliveryRecovery: {
        lastCheckedAt: "2026-08-08T00:00:00.000Z",
        pendingRedeliveryIds: ["100"],
      },
    }
    const request = jest
      .fn()
      .mockResolvedValueOnce({ status: 200, headers: {}, data: [{ id: 100, status_code: 502 }] })
      .mockResolvedValueOnce({ status: 503, headers: {}, data: {} })
    const updateAccount = jest.fn(async () => undefined)
    const deps: GithubDeliveryRecoveryDependencies = {
      listAccounts: jest.fn(async () => [appAccount]),
      request,
      updateAccount,
      appendAudit: jest.fn(async () => undefined),
      now: () => Date.parse("2026-08-09T00:02:00Z"),
    }

    await reconcileGithubAppDeliveries(deps)

    expect(request).toHaveBeenCalledTimes(2)
    expect(updateAccount).toHaveBeenCalledWith(
      "github-delivery",
      "account-github-app",
      expect.objectContaining({
        status: expect.objectContaining({
          deliveryRecovery: expect.objectContaining({ pendingRedeliveryIds: ["100"] }),
        }),
      })
    )
  })

  it("reports remote reconciliation as unavailable for PAT accounts", async () => {
    const updateAccount = jest.fn(async () => undefined)
    const deps: GithubDeliveryRecoveryDependencies = {
      listAccounts: jest.fn(async () => [account("github-pat")]),
      request: jest.fn(),
      updateAccount,
      appendAudit: jest.fn(async () => undefined),
      now: () => Date.parse("2026-08-09T00:02:00Z"),
    }

    await reconcileGithubAppDeliveries(deps)

    expect(deps.request).not.toHaveBeenCalled()
    expect(updateAccount).toHaveBeenCalledWith(
      "github-delivery",
      "account-github-pat",
      expect.objectContaining({
        status: expect.objectContaining({ code: "remote_reconciliation_unavailable" }),
      })
    )
  })
})
