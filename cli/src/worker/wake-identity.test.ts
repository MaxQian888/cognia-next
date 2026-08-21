import { directedBroadcast, resolveWakeIdentity } from "./wake-identity"

const physical = {
  address: "192.168.1.42",
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "AA:BB:CC:DD:EE:FF",
  internal: false,
}

describe("directedBroadcast", () => {
  it("derives the subnet broadcast some routers require", () => {
    // Many routers drop 255.255.255.255 but forward a directed broadcast, so a
    // wake that only used the limited address would work on some networks and
    // silently not on others.
    expect(directedBroadcast("192.168.1.42", "255.255.255.0")).toBe("192.168.1.255")
    expect(directedBroadcast("10.4.3.9", "255.255.0.0")).toBe("10.4.255.255")
  })

  it("returns null for anything that is not an IPv4 pair", () => {
    expect(directedBroadcast("::1", "ffff::")).toBeNull()
    expect(directedBroadcast("192.168.1.999", "255.255.255.0")).toBeNull()
    expect(directedBroadcast("192.168.1.1", "not-a-mask")).toBeNull()
  })
})

describe("resolveWakeIdentity", () => {
  it("advertises physical interfaces in lower case with a directed broadcast", () => {
    expect(resolveWakeIdentity({ en0: [physical] })).toEqual({
      macAddresses: ["aa:bb:cc:dd:ee:ff"],
      broadcastAddress: "192.168.1.255",
    })
  })

  it("skips loopback, IPv6-only, and MAC-less virtual interfaces", () => {
    // Broadcasting to a docker bridge or a VPN tunnel reaches nothing that can
    // wake the machine; listing them just makes the host send dead packets.
    const identity = resolveWakeIdentity({
      lo0: [{ ...physical, address: "127.0.0.1", internal: true }],
      utun0: [{ ...physical, mac: "00:00:00:00:00:00" }],
      en1: [{ ...physical, family: "IPv6", address: "fe80::1" }],
      en0: [physical],
    })

    expect(identity?.macAddresses).toEqual(["aa:bb:cc:dd:ee:ff"])
  })

  it("deduplicates a MAC reported by several aliases", () => {
    const identity = resolveWakeIdentity({
      en0: [physical, { ...physical, address: "192.168.1.43" }],
    })

    expect(identity?.macAddresses).toEqual(["aa:bb:cc:dd:ee:ff"])
  })

  it("advertises nothing rather than a useless entry when no NIC qualifies", () => {
    expect(resolveWakeIdentity({ lo0: [{ ...physical, internal: true }] })).toBeUndefined()
    expect(resolveWakeIdentity({})).toBeUndefined()
  })
})
