import {
  RELAY_HEALTH_PROTOCOL_VERSION,
  classifyHealthz,
  relayHealthUrl,
  relayProtocolMatches,
  type RelayCapabilities,
} from "./relay-health"
import * as relayProbe from "./relay-probe"
import { SIGNALING_PROTOCOL_VERSION } from "./types"

describe("relay-health (pure seam shared with the status service)", () => {
  it("maps signaling URLs to the root health endpoint", () => {
    expect(relayHealthUrl("wss://signaling.cognia.cn/v2/signaling?rid=x#y")).toBe(
      "https://signaling.cognia.cn/healthz"
    )
    expect(relayHealthUrl("ws://127.0.0.1:7892/signaling")).toBe("http://127.0.0.1:7892/healthz")
    expect(relayHealthUrl("ftp://signaling.cognia.cn")).toBeNull()
    expect(relayHealthUrl("not a url")).toBeNull()
  })

  it("classifies the current Worker body as a ready relay", () => {
    expect(
      classifyHealthz({
        ok: true,
        backend: "worker",
        version: "0.1.0",
        capabilities: { protocol: 2, lanes: ["signal", "data"], relayDataLane: true },
      })
    ).toEqual({
      state: "ready",
      backend: "worker",
      version: "0.1.0",
      capabilities: { protocol: 2, lanes: ["signal", "data"], relayDataLane: true },
    })
  })

  it("never upgrades an unrecognised or capability-less body", () => {
    expect(classifyHealthz(null).state).toBe("not-a-relay")
    expect(classifyHealthz({ ok: true }).state).toBe("not-a-relay")
    expect(classifyHealthz({ ok: false, version: "1" }).state).toBe("not-a-relay")
    expect(classifyHealthz({ ok: true, version: "1" }).state).toBe("legacy")
    expect(
      classifyHealthz({ ok: true, version: "1", capabilities: { protocol: 2, lanes: ["signal"] } })
        .state
    ).toBe("legacy")
  })

  it("matches only the protocol generation this client speaks", () => {
    const caps = (protocol: number): RelayCapabilities => ({
      protocol,
      lanes: ["signal", "data"],
      relayDataLane: true,
    })
    expect(relayProtocolMatches(caps(SIGNALING_PROTOCOL_VERSION))).toBe(true)
    expect(relayProtocolMatches(caps(SIGNALING_PROTOCOL_VERSION + 1))).toBe(false)
    expect(relayProtocolMatches(undefined)).toBe(false)
  })

  it("speaks the same protocol generation as the signaling client", () => {
    expect(RELAY_HEALTH_PROTOCOL_VERSION).toBe(SIGNALING_PROTOCOL_VERSION)
  })

  it("is the same implementation the platform probe re-exports", () => {
    expect(relayProbe.classifyHealthz).toBe(classifyHealthz)
    expect(relayProbe.relayHealthUrl).toBe(relayHealthUrl)
    expect(relayProbe.relayProtocolMatches).toBe(relayProtocolMatches)
  })
})
