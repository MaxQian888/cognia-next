import { remoteAccessVerdict, type RemoteAccessInput } from "./remote-access"

const base: RemoteAccessInput = {
  isHost: true,
  relay: "unchecked",
  tunnelOn: false,
  meshConnected: false,
}

describe("remoteAccessVerdict", () => {
  it("is not a question off a Host", () => {
    expect(remoteAccessVerdict({ ...base, isHost: false, tunnelOn: true })).toBe("notHost")
  })

  it("a live tunnel or a ready relay is anywhere", () => {
    expect(remoteAccessVerdict({ ...base, tunnelOn: true })).toBe("anywhere")
    expect(remoteAccessVerdict({ ...base, relay: "ready" })).toBe("anywhere")
    expect(remoteAccessVerdict({ ...base, relay: "unreachable", tunnelOn: true })).toBe("anywhere")
  })

  it("a legacy rendezvous is anywhere with a caveat, and beats the mesh", () => {
    expect(remoteAccessVerdict({ ...base, relay: "legacy", meshConnected: true })).toBe(
      "anywhereLegacy"
    )
    expect(remoteAccessVerdict({ ...base, relay: "cors-blocked" })).toBe("anywhereLegacy")
  })

  it("an overlay address alone is mesh-only, whatever the relay said", () => {
    expect(remoteAccessVerdict({ ...base, relay: "unreachable", meshConnected: true })).toBe(
      "meshOnly"
    )
    expect(remoteAccessVerdict({ ...base, relay: "off", meshConnected: true })).toBe("meshOnly")
  })

  it("an unchecked relay with nothing else is unknown, not a verdict", () => {
    expect(remoteAccessVerdict(base)).toBe("unknown")
  })

  it("every failed or switched-off relay with nothing else is LAN-only", () => {
    for (const relay of ["off", "unreachable", "not-a-relay", "invalid-url"] as const) {
      expect(remoteAccessVerdict({ ...base, relay })).toBe("lanOnly")
    }
  })
})
