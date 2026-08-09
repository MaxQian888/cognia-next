import type { IntegrationAccount } from "@/types/plugin/plugin-integration"
import { rotateGithubWebhookSecret, type GithubWebhookDependencies } from "./github-webhook"

const account: IntegrationAccount = {
  id: "account-1",
  pluginId: "github-delivery",
  integrationId: "github",
  providerId: "github-app",
  authSessionId: "session-1",
  remoteAccountId: "42",
  label: "GitHub",
  enabled: true,
  health: "healthy",
  dedicatedAppConfirmed: true,
  ingressEndpoint: {
    id: "endpoint-1",
    accountId: "account-1",
    routeId: "route-1",
    secretHandle: "old-handle",
    enabled: true,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
  },
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
}

function dependencies(status = 200) {
  const request = jest.fn(async () => ({ status, headers: {}, data: {} }))
  const deps: GithubWebhookDependencies = {
    request: request as unknown as GithubWebhookDependencies["request"],
    saveSecret: jest.fn(async () => undefined),
    deleteSecret: jest.fn(async () => undefined),
    updateAccount: jest.fn(async (_pluginId, _accountId, patch) => ({ ...account, ...patch })),
    syncIngress: jest.fn(async () => 1),
    createHandle: () => "new-handle",
    now: () => Date.parse("2026-08-09T01:00:00Z"),
  }
  return deps
}

describe("rotateGithubWebhookSecret", () => {
  it("updates GitHub first, then switches keyring handles and deletes the old secret", async () => {
    const deps = dependencies()
    await rotateGithubWebhookSecret(account, "https://hooks.example/route-1", "new-secret", deps)

    expect(deps.request).toHaveBeenCalledWith("session-1", "/app/hook/config", {
      method: "PATCH",
      body: {
        url: "https://hooks.example/route-1",
        content_type: "json",
        insecure_ssl: "0",
        secret: "new-secret",
      },
    })
    expect(deps.updateAccount).toHaveBeenCalledWith(
      "github-delivery",
      "account-1",
      expect.objectContaining({
        ingressEndpoint: expect.objectContaining({ secretHandle: "new-handle" }),
      })
    )
    expect(deps.deleteSecret).toHaveBeenCalledWith("old-handle")
  })

  it("keeps the previous handle usable when the remote update fails", async () => {
    const deps = dependencies(500)
    await expect(
      rotateGithubWebhookSecret(account, "https://hooks.example/route-1", "new-secret", deps)
    ).rejects.toThrow("status 500")

    expect(deps.updateAccount).not.toHaveBeenCalled()
    expect(deps.deleteSecret).toHaveBeenCalledWith("new-handle")
    expect(deps.deleteSecret).not.toHaveBeenCalledWith("old-handle")
  })

  it("refuses remote changes without dedicated-App confirmation", async () => {
    const deps = dependencies()
    await expect(
      rotateGithubWebhookSecret(
        { ...account, dedicatedAppConfirmed: false },
        "https://hooks.example/route-1",
        "secret",
        deps
      )
    ).rejects.toThrow("dedicated")
    expect(deps.request).not.toHaveBeenCalled()
  })
})
