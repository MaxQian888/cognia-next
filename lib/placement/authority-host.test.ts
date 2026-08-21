/** @jest-environment jsdom */
import { authorityHostLiveness } from "./authority-host"
import { useRemoteHostStore } from "@/stores/remote-host/remote-host-store"

function seed(overrides: Record<string, unknown>) {
  useRemoteHostStore.setState({
    activeHostId: null,
    hosts: [
      {
        id: "host-a",
        label: "cloud",
        config: { baseUrl: "https://h", deviceJwt: "j", deviceId: "d", serverVersion: "1" },
        credentialRef: "ref",
        addedAt: 1,
        connectionState: "ready",
        ...overrides,
      },
    ] as never,
  })
}

describe("authorityHostLiveness", () => {
  it("distinguishes a host that was never registered from one that is stale", () => {
    // "Not registered here" and "registered but silent" call for different
    // decisions upstream: the first can never recover on its own.
    seed({})
    expect(authorityHostLiveness("ghost")).toBeNull()
    expect(authorityHostLiveness("host-a")).not.toBeNull()
  })

  it("uses the freshest evidence of a successful exchange", () => {
    // `capabilitiesAt` / `featureManifestAt` were written in six places and read
    // in none — they are exactly the record of when this machine last really
    // talked to that host.
    seed({ lastConnectedAt: 100, capabilitiesAt: 500, featureManifestAt: 300 })
    expect(authorityHostLiveness("host-a")).toMatchObject({ lastSeenAt: 500, source: "manifest" })
  })

  it("treats a revoked or version-mismatched host as not coming back", () => {
    // Both are terminal. Letting either hold timing authority while we wait
    // would stop every schedule indefinitely.
    seed({ connectionState: "revoked", lastConnectedAt: Date.now() })
    expect(authorityHostLiveness("host-a")).toMatchObject({ online: false })

    seed({ connectionState: "versionMismatch", lastConnectedAt: Date.now() })
    expect(authorityHostLiveness("host-a")).toMatchObject({ online: false })

    seed({ connectionState: "degraded", lastConnectedAt: Date.now() })
    expect(authorityHostLiveness("host-a")).toMatchObject({ online: true })
  })

  it("reports zero rather than guessing when nothing was ever exchanged", () => {
    seed({})
    expect(authorityHostLiveness("host-a")).toMatchObject({ lastSeenAt: 0 })
  })
})
