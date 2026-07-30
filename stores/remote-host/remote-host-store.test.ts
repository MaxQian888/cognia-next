/**
 * @jest-environment jsdom
 */

const mockSaveRemoteHostCredential = jest.fn(async (..._args: unknown[]) => undefined)
const mockLoadRemoteHostCredential = jest.fn(async (..._args: unknown[]) => null)
const mockClearRemoteHostCredential = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/remote-host/credential-vault", () => ({
  saveRemoteHostCredential: (...args: unknown[]) => mockSaveRemoteHostCredential(...args),
  loadRemoteHostCredential: (...args: unknown[]) => mockLoadRemoteHostCredential(...args),
  clearRemoteHostCredential: (...args: unknown[]) => mockClearRemoteHostCredential(...args),
  remoteHostCredentialRef: (id: string) => `remote-host:${id}`,
}))

import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import type { CapabilityId } from "@/lib/platform/capabilities"
import {
  __resetRoutingForTests,
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  __setRemoteTransportFactoryForTests,
  activeHostCapabilities,
  activeHostFeatureManifest,
  activeHostSupportsFeature,
  refreshHostCapabilities,
  refreshHostFeatureManifest,
  useRemoteHostStore,
} from "./remote-host-store"
import { transport } from "@/lib/tauri"

function makeConfig(overrides: Partial<CompanionConfig> = {}): CompanionConfig {
  return {
    baseUrl: "https://box.example:27890",
    deviceJwt: "device-jwt",
    deviceId: "device-1",
    serverVersion: "1.2.3",
    serverFingerprint: "sha256:paired-spki",
    ...overrides,
  }
}

// Fake transport factory: records the config provider it was handed so we can
// assert it never returns null, and returns an identifiable transport.
let lastProvider: (() => CompanionConfig) | null = null
const fakeRemote: Transport = {
  call: (async () => undefined) as Transport["call"],
  subscribe: () => () => {},
}

beforeEach(() => {
  window.localStorage.clear()
  mockSaveRemoteHostCredential.mockClear()
  mockLoadRemoteHostCredential.mockReset().mockResolvedValue(null)
  mockClearRemoteHostCredential.mockClear()
  useRemoteHostStore.setState({ hosts: [], activeHostId: null })
  __resetRoutingForTests()
  lastProvider = null
  __setRemoteTransportFactoryForTests((provider) => {
    lastProvider = provider
    return fakeRemote
  })
})

afterEach(() => {
  __setRemoteTransportFactoryForTests(null)
  __resetRoutingForTests()
})

describe("addHost", () => {
  it("adds a new host, defaulting the label to the origin and stamping addedAt", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    expect(host.id).toMatch(/^host-/)
    expect(host.label).toBe("https://box.example:27890")
    expect(host.addedAt).toBeGreaterThan(0)
    expect(useRemoteHostStore.getState().hosts).toHaveLength(1)
  })

  it("uses an explicit label and normalizes a trailing-slash baseUrl", () => {
    const host = useRemoteHostStore.getState().addHost({
      label: "  Dev box  ",
      config: makeConfig({ baseUrl: "https://box.example:27890/" }),
    })
    expect(host.label).toBe("Dev box")
    expect(host.config.baseUrl).toBe("https://box.example:27890")
  })

  it("never persists remote JWT or signaling private keys to localStorage", () => {
    useRemoteHostStore.getState().addHost({
      config: makeConfig({
        deviceJwt: "jwt-must-not-persist",
        signalingPrivateKeyJwk: {
          kty: "EC",
          crv: "P-256",
          d: "rtc-private-must-not-persist",
        },
      }),
    })

    const persisted = window.localStorage.getItem("cognia-remote-hosts")
    expect(persisted).not.toContain("jwt-must-not-persist")
    expect(persisted).not.toContain("rtc-private-must-not-persist")
    expect(persisted).toContain("credentialRef")
  })

  it("dedupes by normalized baseUrl: re-pairing refreshes the config, keeps id + label", () => {
    const store = useRemoteHostStore.getState()
    const first = store.addHost({ label: "Box", config: makeConfig({ deviceJwt: "jwt-1" }) })
    const second = store.addHost({
      config: makeConfig({ baseUrl: "https://box.example:27890/", deviceJwt: "jwt-2" }),
    })
    expect(useRemoteHostStore.getState().hosts).toHaveLength(1)
    expect(second.id).toBe(first.id)
    expect(second.label).toBe("Box")
    expect(second.config.deviceJwt).toBe("jwt-2")
  })

  it("leaves other hosts intact when re-pairing one", () => {
    const store = useRemoteHostStore.getState()
    const a = store.addHost({ config: makeConfig({ baseUrl: "https://a:1", deviceJwt: "a1" }) })
    const b = store.addHost({ config: makeConfig({ baseUrl: "https://b:1", deviceJwt: "b1" }) })
    store.addHost({ config: makeConfig({ baseUrl: "https://a:1", deviceJwt: "a2" }) })
    const hosts = useRemoteHostStore.getState().hosts
    expect(hosts).toHaveLength(2)
    expect(hosts.find((h) => h.id === a.id)?.config.deviceJwt).toBe("a2")
    expect(hosts.find((h) => h.id === b.id)?.config.deviceJwt).toBe("b1")
  })
})

describe("updateHostLabel", () => {
  it("renames a host and falls back to the origin on an empty label", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.getState().updateHostLabel(host.id, "Prod")
    expect(useRemoteHostStore.getState().hosts[0].label).toBe("Prod")
    useRemoteHostStore.getState().updateHostLabel(host.id, "   ")
    expect(useRemoteHostStore.getState().hosts[0].label).toBe("https://box.example:27890")
  })

  it("renames only the target host, leaving others unchanged", () => {
    const store = useRemoteHostStore.getState()
    const a = store.addHost({ label: "A", config: makeConfig({ baseUrl: "https://a:1" }) })
    const b = store.addHost({ label: "B", config: makeConfig({ baseUrl: "https://b:1" }) })
    store.updateHostLabel(a.id, "A2")
    const hosts = useRemoteHostStore.getState().hosts
    expect(hosts.find((h) => h.id === a.id)?.label).toBe("A2")
    expect(hosts.find((h) => h.id === b.id)?.label).toBe("B")
  })
})

describe("activateHost / deactivate", () => {
  it("installs the transport + terminal endpoint and stamps lastActiveAt", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.getState().activateHost(host.id)

    expect(useRemoteHostStore.getState().activeHostId).toBe(host.id)
    expect(getActiveRemoteTransport()).toBe(fakeRemote)
    expect(getActiveRemoteEndpoint()).toEqual({
      baseUrl: "https://box.example:27890",
      deviceJwt: "device-jwt",
      serverFingerprint: "sha256:paired-spki",
    })
    expect(useRemoteHostStore.getState().hosts[0].lastActiveAt).toBeGreaterThan(0)
    expect(useRemoteHostStore.getState().hosts[0].connectionState).toBe("connecting")
    expect(useRemoteHostStore.getState().hosts[0].lastConnectedAt).toBeUndefined()
  })

  it("marks ready only after authenticated capability negotiation completes", async () => {
    const manifest = {
      schemaVersion: 1,
      hostBuildId: "1.2.3",
      platform: "headless",
      generatedAt: 123,
      features: {},
      limits: {
        rpcJsonBodyBytes: 65536,
        skillMaxResources: 50,
        skillMaxResourceBytes: 2097152,
        skillUploadChunkBytes: 32768,
        mcpRequestBodyBytes: 1048576,
        maxConcurrentProxyCalls: 32,
      },
    }
    const spy = jest.spyOn(transport, "call").mockImplementation(async (command) => {
      if (command === "host_capabilities") {
        return { platform: "headless", capabilities: ["always-on"] } as never
      }
      return manifest as never
    })
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.getState().activateHost(host.id)
    expect(useRemoteHostStore.getState().hosts[0].connectionState).toBe("connecting")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useRemoteHostStore.getState().hosts[0].connectionState).toBe("ready")
    expect(useRemoteHostStore.getState().hosts[0].lastConnectedAt).toEqual(expect.any(Number))
    spy.mockRestore()
  })

  it("hands the factory a config provider that never returns null", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.getState().activateHost(host.id)
    expect(lastProvider).not.toBeNull()
    expect(lastProvider?.()).toEqual(useRemoteHostStore.getState().hosts[0].config)

    // Even if the row is removed, the provider still returns the captured config
    // (deactivate happens first in removeHost, but the closure must stay safe).
    useRemoteHostStore.setState({ hosts: [] })
    expect(lastProvider?.()).not.toBeNull()
  })

  it("is a no-op for an unknown id", () => {
    useRemoteHostStore.getState().activateHost("nope")
    expect(useRemoteHostStore.getState().activeHostId).toBeNull()
    expect(getActiveRemoteTransport()).toBeNull()
  })

  it("hydrates a missing runtime credential before activation", async () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((candidate) =>
        candidate.id === host.id
          ? { ...candidate, config: { ...candidate.config, deviceJwt: "" } }
          : candidate
      ),
    }))
    ;(mockLoadRemoteHostCredential as jest.Mock).mockResolvedValue({
      deviceJwt: "vault-jwt",
      signalingPrivateKeyJwk: { kty: "EC", crv: "P-256", d: "vault-private" },
    })

    useRemoteHostStore.getState().activateHost(host.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockLoadRemoteHostCredential).toHaveBeenCalledWith(host.id)
    expect(useRemoteHostStore.getState().activeHostId).toBe(host.id)
    expect(getActiveRemoteEndpoint()?.deviceJwt).toBe("vault-jwt")
  })

  it("fails closed when a persisted host has no secure credential", async () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((candidate) =>
        candidate.id === host.id
          ? { ...candidate, config: { ...candidate.config, deviceJwt: "" } }
          : candidate
      ),
    }))

    useRemoteHostStore.getState().activateHost(host.id)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const stored = useRemoteHostStore.getState().hosts[0]
    expect(useRemoteHostStore.getState().activeHostId).toBeNull()
    expect(stored.connectionState).toBe("degraded")
    expect(stored.connectionError).toMatch(/credential is unavailable/)
  })

  it("disconnects the previously selected host when switching", () => {
    const first = useRemoteHostStore
      .getState()
      .addHost({ config: makeConfig({ baseUrl: "https://first:1" }) })
    const second = useRemoteHostStore
      .getState()
      .addHost({ config: makeConfig({ baseUrl: "https://second:1" }) })
    useRemoteHostStore.getState().activateHost(first.id)
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((host) =>
        host.id === first.id ? { ...host, connectionState: "ready" } : host
      ),
    }))

    useRemoteHostStore.getState().activateHost(second.id)

    expect(
      useRemoteHostStore.getState().hosts.find((host) => host.id === first.id)?.connectionState
    ).toBe("disconnected")
  })

  it("deactivate clears the transport, endpoint, and active id", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    const other = useRemoteHostStore
      .getState()
      .addHost({ config: makeConfig({ baseUrl: "https://other:1" }) })
    useRemoteHostStore.getState().activateHost(host.id)
    useRemoteHostStore.getState().deactivate()
    expect(useRemoteHostStore.getState().activeHostId).toBeNull()
    expect(getActiveRemoteTransport()).toBeNull()
    expect(getActiveRemoteEndpoint()).toBeNull()
    expect(
      useRemoteHostStore.getState().hosts.find((candidate) => candidate.id === other.id)
    ).toEqual(expect.objectContaining({ id: other.id }))
  })
})

describe("removeHost", () => {
  it("deactivates first when removing the active host", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.getState().activateHost(host.id)
    useRemoteHostStore.getState().removeHost(host.id)
    expect(useRemoteHostStore.getState().hosts).toHaveLength(0)
    expect(useRemoteHostStore.getState().activeHostId).toBeNull()
    expect(getActiveRemoteTransport()).toBeNull()
  })

  it("leaves the active host untouched when removing a different one", () => {
    const a = useRemoteHostStore
      .getState()
      .addHost({ config: makeConfig({ baseUrl: "https://a:1" }) })
    const b = useRemoteHostStore
      .getState()
      .addHost({ config: makeConfig({ baseUrl: "https://b:1" }) })
    useRemoteHostStore.getState().activateHost(a.id)
    useRemoteHostStore.getState().removeHost(b.id)
    expect(useRemoteHostStore.getState().hosts.map((h) => h.id)).toEqual([a.id])
    expect(useRemoteHostStore.getState().activeHostId).toBe(a.id)
  })
})

describe("default transport factory", () => {
  it("installs a real CompanionTransport when no factory override is set", () => {
    // Restore the production factory (beforeEach injects a fake), then activate.
    __setRemoteTransportFactoryForTests(null)
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.getState().activateHost(host.id)
    expect(getActiveRemoteTransport()).not.toBeNull()
    expect(getActiveRemoteEndpoint()).toEqual({
      baseUrl: "https://box.example:27890",
      deviceJwt: "device-jwt",
      serverFingerprint: "sha256:paired-spki",
    })
  })
})

describe("re-pair while active", () => {
  it("re-installs the endpoint with the refreshed credential", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig({ deviceJwt: "old" }) })
    useRemoteHostStore.getState().activateHost(host.id)
    useRemoteHostStore.getState().addHost({ config: makeConfig({ deviceJwt: "new" }) })
    expect(getActiveRemoteEndpoint()?.deviceJwt).toBe("new")
  })
})

describe("host capabilities", () => {
  // A remote host is never a row in `pairedDevices` — pairing runs client to
  // host, not the other way — so asking it directly is the only way a client
  // can know what it can do. Without it, workflow preflight judged a cloud
  // server by the desktop's own baseline.
  function seedActive(capabilities?: CapabilityId[]) {
    useRemoteHostStore.setState({
      activeHostId: "h1",
      hosts: [
        {
          id: "h1",
          label: "cloud",
          config: makeConfig(),
          credentialRef: "remote-host:h1",
          addedAt: 1,
          connectionState: "ready",
          ...(capabilities ? { capabilities } : {}),
        },
      ],
    })
  }

  it("stores what the host reports", async () => {
    seedActive()
    const spy = jest
      .spyOn(transport, "call")
      .mockResolvedValue({ platform: "headless", capabilities: ["always-on", "headless"] } as never)

    await expect(refreshHostCapabilities("h1")).resolves.toEqual(["always-on", "headless"])
    expect(spy).toHaveBeenCalledWith("host_capabilities", {})
    expect(useRemoteHostStore.getState().hosts[0].capabilities).toEqual(["always-on", "headless"])
    expect(useRemoteHostStore.getState().hosts[0].capabilitiesAt).toEqual(expect.any(Number))
    spy.mockRestore()
  })

  it("keeps the last known list when the host cannot answer", async () => {
    // An older host, or one momentarily unreachable. Blanking the list would
    // silently fall back to judging it by the local baseline — the bug.
    seedActive(["always-on"])
    const spy = jest.spyOn(transport, "call").mockRejectedValue(new Error("unknown_command"))

    await expect(refreshHostCapabilities("h1")).resolves.toBeNull()
    expect(useRemoteHostStore.getState().hosts[0].capabilities).toEqual(["always-on"])
    spy.mockRestore()
  })

  it.each([
    ["device revoked by host", "revoked"],
    ["host requires a version upgrade", "versionMismatch"],
  ] as const)("classifies connection failure %s as %s", async (message, expectedState) => {
    seedActive(["always-on"])
    const spy = jest.spyOn(transport, "call").mockRejectedValue(new Error(message))

    await expect(refreshHostCapabilities("h1")).resolves.toBeNull()

    expect(useRemoteHostStore.getState().hosts[0]).toMatchObject({
      connectionState: expectedState,
      connectionError: message,
    })
    spy.mockRestore()
  })

  it("keeps the last known list when the reply carries no capability array", async () => {
    // A reply we cannot read is "the host did not tell us", exactly like a
    // throw. Writing `[]` here is indistinguishable from a host that reported
    // no capabilities at all, which is the local-baseline misjudgement this
    // probe exists to end.
    seedActive(["always-on"])
    const spy = jest.spyOn(transport, "call").mockResolvedValue({ capabilities: "nope" } as never)

    await expect(refreshHostCapabilities("h1")).resolves.toBeNull()
    expect(useRemoteHostStore.getState().hosts[0].capabilities).toEqual(["always-on"])
    spy.mockRestore()
  })

  it("drops tags it does not recognise and caps the list", async () => {
    // The stored list gates workflow preflight, so an unrecognised tag must
    // not read as a granted capability.
    seedActive()
    const spy = jest.spyOn(transport, "call").mockResolvedValue({
      capabilities: [
        "always-on",
        "teleportation",
        42,
        null,
        "plugin:github-delivery",
        ...Array.from({ length: 70 }, (_, i) => `plugin:filler-${i}`),
      ],
    } as never)

    const stored = await refreshHostCapabilities("h1")
    expect(stored).toHaveLength(64)
    expect(stored).toContain("always-on")
    expect(stored).toContain("plugin:github-delivery")
    expect(stored).not.toContain("teleportation")
    spy.mockRestore()
  })

  it("reports nothing while driving locally", () => {
    useRemoteHostStore.setState({ activeHostId: null, hosts: [] })
    expect(activeHostCapabilities()).toEqual([])
  })

  it("reports only the active host's capabilities", () => {
    useRemoteHostStore.setState({
      activeHostId: "h1",
      hosts: [
        {
          id: "h1",
          label: "a",
          config: makeConfig(),
          credentialRef: "remote-host:h1",
          addedAt: 1,
          connectionState: "ready",
          capabilities: ["headless"],
        },
        {
          id: "h2",
          label: "b",
          config: makeConfig(),
          credentialRef: "remote-host:h2",
          addedAt: 1,
          connectionState: "disconnected",
          capabilities: ["camera"],
        },
      ],
    })
    expect(activeHostCapabilities()).toEqual(["headless"])
  })
})

describe("host feature manifest", () => {
  function seedActive() {
    useRemoteHostStore.setState({
      activeHostId: "h1",
      hosts: [
        {
          id: "h1",
          label: "cloud",
          config: makeConfig(),
          credentialRef: "remote-host:h1",
          addedAt: 1,
          connectionState: "ready",
        },
      ],
    })
  }

  const manifest = {
    schemaVersion: 1 as const,
    hostBuildId: "1.2.3",
    platform: "headless" as const,
    generatedAt: 123,
    features: {
      "skills.catalog": { version: 1, operations: ["skills_scan_native"] },
    },
    limits: {
      rpcJsonBodyBytes: 64 * 1024,
      skillMaxResources: 50,
      skillMaxResourceBytes: 2 * 1024 * 1024,
      skillUploadChunkBytes: 32 * 1024,
      mcpRequestBodyBytes: 1024 * 1024,
      maxConcurrentProxyCalls: 32,
    },
  }

  it("caches a valid manifest and gates by exact operation", async () => {
    seedActive()
    const spy = jest.spyOn(transport, "call").mockResolvedValue(manifest as never)

    await expect(refreshHostFeatureManifest("h1")).resolves.toEqual(manifest)
    expect(spy).toHaveBeenCalledWith("host_feature_manifest", {})
    expect(activeHostFeatureManifest()).toEqual(manifest)
    expect(activeHostSupportsFeature("skills.catalog", "skills_scan_native")).toBe(true)
    expect(activeHostSupportsFeature("skills.catalog", "skills_install_native")).toBe(false)
    spy.mockRestore()
  })

  it("rejects malformed or build-mismatched manifests instead of enabling writes", async () => {
    seedActive()
    const spy = jest
      .spyOn(transport, "call")
      .mockResolvedValue({ ...manifest, hostBuildId: "older", schemaVersion: 99 } as never)

    await expect(refreshHostFeatureManifest("h1")).resolves.toBeNull()
    expect(activeHostFeatureManifest()).toBeNull()
    expect(activeHostSupportsFeature("skills.catalog", "skills_scan_native")).toBe(false)
    spy.mockRestore()
  })

  it("rejects a valid manifest for another host build and marks a version mismatch", async () => {
    seedActive()
    const spy = jest
      .spyOn(transport, "call")
      .mockResolvedValue({ ...manifest, hostBuildId: "older" } as never)

    await expect(refreshHostFeatureManifest("h1")).resolves.toBeNull()

    expect(useRemoteHostStore.getState().hosts[0]).toMatchObject({
      connectionState: "versionMismatch",
      featureManifest: undefined,
    })
    spy.mockRestore()
  })

  it("does not cache a manifest when the requested host row disappeared", async () => {
    seedActive()
    const spy = jest.spyOn(transport, "call").mockResolvedValue(manifest as never)

    await expect(refreshHostFeatureManifest("missing")).resolves.toBeNull()

    expect(activeHostFeatureManifest()).toBeNull()
    spy.mockRestore()
  })

  it("returns no active manifest while local or when the cached build is stale", () => {
    seedActive()
    useRemoteHostStore.setState((state) => ({
      activeHostId: null,
      hosts: state.hosts.map((host) => ({ ...host, featureManifest: manifest })),
    }))
    expect(activeHostFeatureManifest()).toBeNull()

    useRemoteHostStore.setState((state) => ({
      activeHostId: "h1",
      hosts: state.hosts.map((host) => ({
        ...host,
        featureManifest: { ...manifest, hostBuildId: "old" },
      })),
    }))
    expect(activeHostFeatureManifest()).toBeNull()
  })

  it("never authorizes operations from a cached manifest while reconnecting", () => {
    seedActive()
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((host) => ({
        ...host,
        connectionState: "connecting",
        featureManifest: manifest,
        featureManifestAt: Date.now(),
      })),
    }))

    expect(activeHostFeatureManifest()).toBeNull()
    expect(activeHostSupportsFeature("skills.catalog", "skills_scan_native")).toBe(false)
  })

  it("clears a previously cached manifest when refresh fails", async () => {
    seedActive()
    useRemoteHostStore.setState((state) => ({
      hosts: state.hosts.map((host) => ({
        ...host,
        featureManifest: manifest,
        featureManifestAt: Date.now(),
      })),
    }))
    const spy = jest.spyOn(transport, "call").mockRejectedValue(new Error("offline"))

    await expect(refreshHostFeatureManifest("h1")).resolves.toBeNull()
    expect(
      useRemoteHostStore.getState().hosts.find((host) => host.id === "h1")?.featureManifest
    ).toBeUndefined()
    expect(activeHostSupportsFeature("skills.catalog", "skills_scan_native")).toBe(false)
    spy.mockRestore()
  })
})

describe("persisted host migration", () => {
  it("moves legacy credentials to the vault and strips persisted secrets", async () => {
    const legacyConfig = makeConfig({
      deviceJwt: "legacy-jwt",
      signalingPrivateKeyJwk: {
        kty: "EC",
        crv: "P-256",
        d: "legacy-private",
      },
    })
    window.localStorage.setItem(
      "cognia-remote-hosts",
      JSON.stringify({
        version: 1,
        state: {
          hosts: [
            {
              id: "legacy-host",
              label: "Legacy",
              config: legacyConfig,
              addedAt: 1,
              connectionState: "ready",
              connectionError: "old error",
            },
          ],
          activeHostId: "legacy-host",
        },
      })
    )

    await useRemoteHostStore.persist.rehydrate()

    expect(mockSaveRemoteHostCredential).toHaveBeenCalledWith("legacy-host", legacyConfig)
    const migrated = useRemoteHostStore.getState().hosts[0]
    expect(migrated).toMatchObject({
      id: "legacy-host",
      credentialRef: "remote-host:legacy-host",
      connectionState: "disconnected",
      connectionError: undefined,
    })
    expect(migrated.config.deviceJwt).toBe("")
    expect(migrated.config.signalingPrivateKeyJwk).toBeUndefined()
    expect(useRemoteHostStore.getState().activeHostId).toBeNull()
  })
})
