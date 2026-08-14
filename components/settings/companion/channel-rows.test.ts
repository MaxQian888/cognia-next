import { buildChannelRows, summarizeChannels, type ChannelRow } from "./channel-rows"

const RUNNING_LAN = { running: true, bindMode: "lan" as const, boundPort: 27890 }
const STOPPED = { running: false, bindMode: "none" as const, boundPort: null }

function base(overrides: Partial<Parameters<typeof buildChannelRows>[0]> = {}) {
  return buildChannelRows({
    server: RUNNING_LAN,
    mdnsOn: false,
    tunnelUrl: null,
    webrtcEnabled: false,
    ...overrides,
  })
}

function row(rows: ChannelRow[], id: ChannelRow["id"]): ChannelRow {
  const found = rows.find((r) => r.id === id)
  if (!found) throw new Error(`no ${id} row`)
  return found
}

describe("buildChannelRows", () => {
  it("always returns all four channels so none can silently disappear", () => {
    expect(base().map((r) => r.id)).toEqual(["lan", "mdns", "tunnel", "webrtc"])
  })

  describe("LAN", () => {
    it("is live when the server is bound to the network", () => {
      expect(row(base(), "lan").state).toBe("live")
    })

    it("is blocked, not off, when bound to loopback", () => {
      // Loopback "runs" but answers only this machine. Calling that `off` would
      // suggest flipping a switch; the fix is changing the bind mode.
      const lan = row(
        base({ server: { running: true, bindMode: "loopback", boundPort: 27890 } }),
        "lan"
      )
      expect(lan.state).toBe("blocked")
      expect(lan.blockedReason).toBe("loopbackOnly")
    })

    it("is blocked when the server is stopped", () => {
      const lan = row(base({ server: STOPPED }), "lan")
      expect(lan.state).toBe("blocked")
      expect(lan.blockedReason).toBe("serverStopped")
    })

    it("adopts the probed LAN address and latency", () => {
      const rows = base({
        probes: [
          { url: "https://127.0.0.1:27890", reachable: true, latencyMs: 1 },
          { url: "https://192.168.1.42:27890", reachable: true, latencyMs: 7 },
        ],
      })
      // Loopback is excluded: it is not a channel a phone can use, and picking
      // it would report the machine as reachable when nothing off-box is.
      expect(row(rows, "lan").address).toBe("https://192.168.1.42:27890")
      expect(row(rows, "lan").latencyMs).toBe(7)
    })

    it("prefers a reachable probe over a failing one", () => {
      const rows = base({
        probes: [
          { url: "https://10.0.0.5:27890", reachable: false, error: "timeout" },
          { url: "https://192.168.1.42:27890", reachable: true, latencyMs: 4 },
        ],
      })
      expect(row(rows, "lan").reachable).toBe(true)
      expect(row(rows, "lan").address).toBe("https://192.168.1.42:27890")
    })

    it("reports the failure when every LAN probe failed", () => {
      const rows = base({
        probes: [{ url: "https://10.0.0.5:27890", reachable: false, error: "timeout" }],
      })
      expect(row(rows, "lan").reachable).toBe(false)
      expect(row(rows, "lan").probeError).toBe("timeout")
    })
  })

  describe("mDNS", () => {
    it("is off when the broadcast is not running", () => {
      expect(row(base({ mdnsOn: false }), "mdns").state).toBe("off")
    })

    it("is live when broadcasting", () => {
      expect(row(base({ mdnsOn: true }), "mdns").state).toBe("live")
    })

    it("is blocked when the server is down, even while the switch is on", () => {
      // Advertising a server that is not listening sends phones to a dead port.
      const mdns = row(base({ server: STOPPED, mdnsOn: true }), "mdns")
      expect(mdns.state).toBe("blocked")
      expect(mdns.blockedReason).toBe("serverStopped")
    })

    it("stays off — not blocked — when switched off AND the server is down", () => {
      // `blocked` is defined as "switched on, yet something upstream makes it
      // unusable", so it must not swallow the case the user simply turned off.
      // Reporting `blocked/serverStopped` here would point at the wrong fix:
      // starting the server still would not make mDNS advertise.
      const mdns = row(base({ server: STOPPED, mdnsOn: false }), "mdns")
      expect(mdns.state).toBe("off")
      expect(mdns.blockedReason).toBeUndefined()
    })
  })

  describe("tunnel", () => {
    it("is off with no tunnel up", () => {
      expect(row(base(), "tunnel").state).toBe("off")
    })

    it("is live and shows the public URL", () => {
      const tunnel = row(base({ tunnelUrl: "https://x.trycloudflare.com" }), "tunnel")
      expect(tunnel.state).toBe("live")
      expect(tunnel.address).toBe("https://x.trycloudflare.com")
    })

    it("takes its probe result from the matching URL only", () => {
      const rows = base({
        tunnelUrl: "https://x.trycloudflare.com",
        probes: [
          { url: "https://192.168.1.42:27890", reachable: true, latencyMs: 3 },
          { url: "https://x.trycloudflare.com", reachable: true, latencyMs: 88 },
        ],
      })
      expect(row(rows, "tunnel").latencyMs).toBe(88)
    })
  })

  describe("WebRTC", () => {
    it("is off when disabled", () => {
      expect(row(base({ webrtcEnabled: false }), "webrtc").state).toBe("off")
    })

    it("is live when enabled with a rendezvous server", () => {
      const webrtc = row(
        base({ webrtcEnabled: true, signalingUrl: "wss://sig.example/signaling" }),
        "webrtc"
      )
      expect(webrtc.state).toBe("live")
      expect(webrtc.address).toBe("wss://sig.example/signaling")
    })

    it("is blocked when enabled with nowhere to rendezvous", () => {
      // The switch reads as on while the channel cannot be established — the
      // exact shape of "configured but silently dead" this table exists to show.
      const webrtc = row(base({ webrtcEnabled: true, signalingUrl: undefined }), "webrtc")
      expect(webrtc.state).toBe("blocked")
      expect(webrtc.blockedReason).toBe("noSignaling")
    })
  })
})

describe("summarizeChannels", () => {
  it("is reachable when any channel is live", () => {
    expect(summarizeChannels(base({ mdnsOn: true }))).toBe("reachable")
  })

  it("is blocked when nothing is live but something is trying", () => {
    expect(summarizeChannels(base({ server: STOPPED }))).toBe("blocked")
  })

  it("is none when every channel is simply switched off", () => {
    const rows: ChannelRow[] = [
      { id: "lan", state: "off" },
      { id: "mdns", state: "off" },
      { id: "tunnel", state: "off" },
      { id: "webrtc", state: "off" },
    ]
    expect(summarizeChannels(rows)).toBe("none")
  })
})
