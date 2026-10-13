/** @jest-environment jsdom */
import type { RemoteHostTarget } from "@/lib/remote-host/target-transport"
import { closeManagementChannel } from "@/lib/remote-host/management-channel"
import { REMOTE_HOST_KEYS_REFRESH_EVENT } from "@/lib/host-secrets/remote-host-keys"

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
      items: [{ kind: "provider", name: "deepseek", setAt: 1, setBy: { deviceId: "d" } }],
    })
    await expect(listHostSecrets(HOST, deps())).resolves.toEqual([
      { kind: "provider", name: "deepseek", setAt: 1, setBy: { deviceId: "d" } },
    ])
    expect(call).toHaveBeenCalledWith("host_secret_list", { pageSize: 1000 })
    call.mockResolvedValueOnce(null)
    await expect(listHostSecrets(HOST, deps())).resolves.toEqual([])
  })

  it("walks every page, handing each token back unchanged", async () => {
    call
      .mockResolvedValueOnce({ items: [{ kind: "git", name: "github.com" }], nextPageToken: "p2" })
      .mockResolvedValueOnce({ items: [{ kind: "provider", name: "deepseek" }] })
    await expect(listHostSecrets(HOST, deps())).resolves.toEqual([
      { kind: "git", name: "github.com" },
      { kind: "provider", name: "deepseek" },
    ])
    expect(call).toHaveBeenNthCalledWith(1, "host_secret_list", { pageSize: 1000 })
    expect(call).toHaveBeenNthCalledWith(2, "host_secret_list", {
      pageSize: 1000,
      pageToken: "p2",
    })
  })

  it("refuses a walk that never ends rather than show part of the list", async () => {
    call.mockResolvedValue({ items: [{ kind: "git", name: "github.com" }], nextPageToken: "same" })
    await expect(listHostSecrets(HOST, deps())).rejects.toThrow("Incomplete collection")
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

  it("asks the model picker to re-read the Host's keys after a provider key changes", async () => {
    const refreshed = jest.fn()
    window.addEventListener(REMOTE_HOST_KEYS_REFRESH_EVENT, refreshed)
    try {
      call.mockResolvedValue({ kind: "provider", name: "deepseek" })
      await setHostSecret(HOST, { kind: "provider", name: "deepseek", value: "k" }, "l", deps())
      expect(refreshed).toHaveBeenCalledTimes(1)
      await deleteHostSecret(HOST, { kind: "provider", name: "deepseek" }, "l", deps())
      expect(refreshed).toHaveBeenCalledTimes(2)
      call.mockResolvedValue({ kind: "git", name: "github.com" })
      await setHostSecret(HOST, { kind: "git", name: "github.com", value: "t" }, "l", deps())
      await deleteHostSecret(HOST, { kind: "git", name: "github.com" }, "l", deps())
      expect(refreshed).toHaveBeenCalledTimes(2)
    } finally {
      window.removeEventListener(REMOTE_HOST_KEYS_REFRESH_EVENT, refreshed)
    }
  })
})
