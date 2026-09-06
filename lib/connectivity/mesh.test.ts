import {
  advertisedHostIsCarried,
  meshProviderState,
  preferredMeshAddress,
  type MeshStatus,
} from "./mesh"

const status: MeshStatus = {
  networks: [
    {
      provider: "tailscale",
      installed: true,
      addresses: [
        { interface: "utun4", address: "fd7a:115c:a1e0::1" },
        { interface: "utun4", address: "100.101.2.3" },
      ],
    },
    { provider: "zerotier", installed: true, addresses: [] },
  ],
}

describe("meshProviderState", () => {
  it("is connected with an address, installed without one, absent without a binary", () => {
    expect(meshProviderState(status.networks[0])).toBe("connected")
    expect(meshProviderState(status.networks[1])).toBe("installed")
    expect(meshProviderState({ provider: "zerotier", installed: false, addresses: [] })).toBe(
      "absent"
    )
  })
})

describe("preferredMeshAddress", () => {
  it("offers the IPv4 address first and nothing when nothing is carried", () => {
    expect(preferredMeshAddress(status)).toEqual({ provider: "tailscale", address: "100.101.2.3" })
    expect(
      preferredMeshAddress({
        networks: [
          {
            provider: "tailscale",
            installed: true,
            addresses: [{ interface: "utun4", address: "fd7a:115c:a1e0::1" }],
          },
        ],
      })
    ).toEqual({ provider: "tailscale", address: "fd7a:115c:a1e0::1" })
    expect(preferredMeshAddress({ networks: [] })).toBeNull()
    expect(preferredMeshAddress(null)).toBeNull()
  })
})

describe("advertisedHostIsCarried", () => {
  it("is true only for an address an interface carries right now", () => {
    expect(advertisedHostIsCarried(status, "100.101.2.3")).toBe(true)
    expect(advertisedHostIsCarried(status, " 100.101.2.3 ")).toBe(true)
    expect(advertisedHostIsCarried(status, "100.101.2.4")).toBe(false)
    expect(advertisedHostIsCarried(status, "")).toBe(false)
    expect(advertisedHostIsCarried(null, "100.101.2.3")).toBe(false)
  })
})
