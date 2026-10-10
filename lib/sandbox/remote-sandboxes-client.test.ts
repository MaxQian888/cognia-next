import type { DesktopRemoteSandboxes } from "@/types/sandbox/remote-sandboxes"

const call = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => call(...args) },
}))

import {
  emptyRemoteSandboxes,
  providerCredentialSecretId,
  providerSecretId,
  remoteSandboxesGet,
  remoteSandboxesSet,
  withoutProvider,
} from "./remote-sandboxes-client"

function settings(): DesktopRemoteSandboxes {
  return {
    version: 1,
    providers: {
      version: 1,
      providers: [
        {
          id: "cloud",
          kind: "e2b",
          credential: { secretId: providerSecretId("cloud") },
          settings: {},
        },
        {
          id: "cluster",
          kind: "kubernetes",
          credential: { env: "KUBECONFIG_YAML" },
          settings: { connection: "kubeconfig", namespace: "sandboxes" },
        },
      ],
      defaultProviderId: "cloud",
    },
    registryAllowlist: [],
  }
}

describe("remote sandboxes client", () => {
  beforeEach(() => call.mockReset())

  it("reads and writes through the two desktop commands", async () => {
    call.mockResolvedValueOnce({ availability: "no_providers" })
    await remoteSandboxesGet()
    expect(call).toHaveBeenCalledWith("remote_sandboxes_get")
    const update = { settings: emptyRemoteSandboxes(), secrets: { "remote-sandbox:x": null } }
    call.mockResolvedValueOnce({})
    await remoteSandboxesSet(update)
    expect(call).toHaveBeenLastCalledWith("remote_sandboxes_set", { update })
  })

  it("names the stored credential of a secret-store provider only", () => {
    const [cloud, cluster] = settings().providers.providers
    expect(providerCredentialSecretId(cloud!)).toBe("remote-sandbox:cloud")
    expect(providerCredentialSecretId(cluster!)).toBeUndefined()
  })

  it("removing a provider drops its default pointer and its credential", () => {
    const { settings: next, secrets } = withoutProvider(settings(), "cloud")
    expect(next.providers.providers.map((provider) => provider.id)).toEqual(["cluster"])
    expect(next.providers.defaultProviderId).toBeUndefined()
    expect(secrets).toEqual({ "remote-sandbox:cloud": null })
  })

  it("keeps a credential another provider still names", () => {
    const shared = settings()
    shared.providers.providers[1] = {
      id: "cloud-2",
      kind: "e2b",
      credential: { secretId: "remote-sandbox:cloud" },
      settings: {},
    }
    const { settings: next, secrets } = withoutProvider(shared, "cloud")
    expect(secrets).toEqual({})
    expect(next.providers.providers).toHaveLength(1)
  })
})
