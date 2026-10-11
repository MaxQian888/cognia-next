/** @jest-environment jsdom */
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import { closeManagementChannel } from "@/lib/remote-host/management-channel"

import {
  HOST_SECRET_LEASE_OPERATIONS,
  deleteHostSecret,
  isManagedHere,
  listHostSecrets,
  requestHostSecretsLease,
  setHostSecret,
  type HostSecretDeps,
} from "./host-secrets"

const HOST = "host-secrets-test"
const call = jest.fn()

function deps(): HostSecretDeps {
  return {
    channel: {
      openTarget: async () =>
        ({
          host: { id: HOST, label: "Mac mini" },
          transport: { call, subscribe: jest.fn(() => () => undefined) },
          close: jest.fn(),
        }) as unknown as RemoteHostTarget,
    },
  }
}

beforeEach(() => call.mockReset())
afterEach(() => closeManagementChannel(HOST))

describe("host secrets over the management channel", () => {
  it("lists names and writers, and tolerates an empty answer", async () => {
    call.mockResolvedValueOnce({
      entries: [{ kind: "provider", name: "deepseek", setAt: 1, setBy: { deviceId: "d" } }],
    })
    await expect(listHostSecrets(HOST, deps())).resolves.toEqual([
      { kind: "provider", name: "deepseek", setAt: 1, setBy: { deviceId: "d" } },
    ])
    expect(call).toHaveBeenCalledWith("host_secret_list", {})
    call.mockResolvedValueOnce(null)
    await expect(listHostSecrets(HOST, deps())).resolves.toEqual([])
  })

  it("asks for one lease covering the panel's writes, not the list", async () => {
    call.mockResolvedValueOnce({ token: "t", operations: [], expiresAt: 1 })
    await requestHostSecretsLease(HOST, deps())
    expect(call).toHaveBeenCalledWith("host_admin_lease_issue", {
      operations: [...HOST_SECRET_LEASE_OPERATIONS],
      ttlSeconds: 600,
    })
    expect(HOST_SECRET_LEASE_OPERATIONS).not.toContain("host_secret_list")
  })

  it("writes a provider key and a git token under the lease, trimmed", async () => {
    call.mockResolvedValue({ kind: "provider", name: "deepseek" })
    await setHostSecret(
      HOST,
      { kind: "provider", name: " deepseek ", value: " sk-1 " },
      "lease",
      deps()
    )
    expect(call).toHaveBeenLastCalledWith("host_provider_credential_set", {
      providerId: "deepseek",
      apiKey: "sk-1",
      adminLease: "lease",
    })
    await setHostSecret(
      HOST,
      { kind: "git", name: "https://github.com/acme/app", value: "ghp" },
      "lease",
      deps()
    )
    expect(call).toHaveBeenLastCalledWith("host_git_credential_set", {
      host: "https://github.com/acme/app",
      token: "ghp",
      adminLease: "lease",
    })
  })

  it("removes provider keys and git tokens, and leaves connector credentials to their connection", async () => {
    call.mockResolvedValue(null)
    await deleteHostSecret(HOST, { kind: "provider", name: "deepseek" }, "lease", deps())
    expect(call).toHaveBeenLastCalledWith("host_provider_credential_delete", {
      providerId: "deepseek",
      adminLease: "lease",
    })
    await deleteHostSecret(HOST, { kind: "git", name: "github.com" }, "lease", deps())
    expect(call).toHaveBeenLastCalledWith("host_git_credential_delete", {
      host: "github.com",
      adminLease: "lease",
    })
    await expect(
      deleteHostSecret(HOST, { kind: "connector", name: "cai_1:botToken" }, "lease", deps())
    ).rejects.toThrow(/with their connection/)
    expect(isManagedHere("connector")).toBe(false)
  })
})
