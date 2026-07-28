/**
 * @jest-environment jsdom
 */

import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import {
  __resetRoutingForTests,
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
} from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import { __setRemoteTransportFactoryForTests, useRemoteHostStore } from "./remote-host-store"

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

  it("deactivate clears the transport, endpoint, and active id", () => {
    const host = useRemoteHostStore.getState().addHost({ config: makeConfig() })
    useRemoteHostStore.getState().activateHost(host.id)
    useRemoteHostStore.getState().deactivate()
    expect(useRemoteHostStore.getState().activeHostId).toBeNull()
    expect(getActiveRemoteTransport()).toBeNull()
    expect(getActiveRemoteEndpoint()).toBeNull()
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
