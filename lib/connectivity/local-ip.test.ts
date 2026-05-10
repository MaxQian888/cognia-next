/**
 * @jest-environment jsdom
 */

import { enumerateSlash24, extractPrivateIpv4, getPrivateLocalIps, isPrivateIpv4 } from "./local-ip"

interface FakeIceEvent {
  candidate: { candidate: string } | null
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = []
  iceGatheringState: "new" | "gathering" | "complete" = "new"
  onicecandidate: ((ev: FakeIceEvent) => void) | null = null
  onicegatheringstatechange: (() => void) | null = null
  createDataChannelFails = false
  createOfferFails = false

  constructor(public readonly config: RTCConfiguration) {
    FakePeerConnection.instances.push(this)
  }

  createDataChannel(_label: string) {
    if (this.createDataChannelFails) throw new Error("DC unavailable")
    return { close() {} }
  }

  async createOffer(_opts: unknown): Promise<RTCSessionDescriptionInit> {
    if (this.createOfferFails) throw new Error("offer failed")
    return { type: "offer", sdp: "" }
  }

  async setLocalDescription(_d: RTCSessionDescriptionInit): Promise<void> {
    // ICE gathering simulated via emit() below.
  }

  close() {
    /* no-op */
  }

  emit(candidate: string | null) {
    this.onicecandidate?.({ candidate: candidate === null ? null : { candidate } } as FakeIceEvent)
  }

  finishGathering() {
    this.iceGatheringState = "complete"
    this.onicegatheringstatechange?.()
  }
}

beforeEach(() => {
  FakePeerConnection.instances.length = 0
})

describe("isPrivateIpv4", () => {
  it.each([
    ["10.0.0.1", true],
    ["10.255.255.254", true],
    ["192.168.1.1", true],
    ["192.168.55.200", true],
    ["172.16.0.1", true],
    ["172.31.255.254", true],
    ["172.15.0.1", false],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
    ["127.0.0.1", false],
    ["1.2.3", false],
    ["nope", false],
  ])("classifies %s correctly", (ip, expected) => {
    expect(isPrivateIpv4(ip)).toBe(expected)
  })
})

describe("extractPrivateIpv4", () => {
  it("pulls a host IPv4 out of a host candidate", () => {
    expect(extractPrivateIpv4("candidate:0 1 UDP 2122252543 192.168.1.42 50000 typ host")).toBe(
      "192.168.1.42"
    )
  })
  it("returns null for mDNS-anonymised .local hostnames", () => {
    expect(
      extractPrivateIpv4("candidate:0 1 UDP 2122252543 abcd1234-deadbeef.local 50000 typ host")
    ).toBeNull()
  })
  it("returns null when the IP is public", () => {
    expect(extractPrivateIpv4("candidate:0 1 UDP 2122252543 8.8.8.8 50000 typ host")).toBeNull()
  })
  it("returns null when the line has no IPv4", () => {
    expect(extractPrivateIpv4("candidate:0 1 UDP 2122252543 ::1 50000 typ host")).toBeNull()
  })
})

describe("enumerateSlash24", () => {
  it("expands the /24 and skips the source IP", () => {
    const list = enumerateSlash24("192.168.1.55")
    expect(list).toHaveLength(253)
    expect(list).toContain("192.168.1.1")
    expect(list).toContain("192.168.1.254")
    expect(list).not.toContain("192.168.1.55")
  })
  it("returns [] for malformed input", () => {
    expect(enumerateSlash24("nope")).toEqual([])
    expect(enumerateSlash24("1.2.3")).toEqual([])
  })
})

describe("getPrivateLocalIps", () => {
  it("returns [] when RTCPeerConnection is unavailable", async () => {
    const result = await getPrivateLocalIps({ rtcImpl: undefined as never })
    expect(result).toEqual([])
  })

  it("returns [] when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await getPrivateLocalIps({
      rtcImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      signal: controller.signal,
    })
    expect(result).toEqual([])
  })

  it("collects unique private IPs from host candidates", async () => {
    const promise = getPrivateLocalIps({
      rtcImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      timeoutMs: 5_000,
    })
    // Defer to allow the constructor to run.
    await Promise.resolve()
    const pc = FakePeerConnection.instances.at(-1)!
    pc.emit("candidate:0 1 UDP 2122252543 192.168.1.42 50000 typ host")
    pc.emit("candidate:0 1 UDP 2122252543 192.168.1.42 50000 typ host") // duplicate
    pc.emit("candidate:1 1 UDP 2122252543 10.0.0.5 50000 typ host")
    pc.emit("candidate:2 1 UDP 2122252543 8.8.8.8 50000 typ host") // public, dropped
    pc.finishGathering()
    const result = await promise
    expect(result.sort()).toEqual(["10.0.0.5", "192.168.1.42"])
  })

  it("finishes when an end-of-candidates null arrives", async () => {
    const promise = getPrivateLocalIps({
      rtcImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      timeoutMs: 5_000,
    })
    await Promise.resolve()
    const pc = FakePeerConnection.instances.at(-1)!
    pc.emit("candidate:0 1 UDP 2122252543 192.168.50.10 50000 typ host")
    pc.emit(null)
    expect(await promise).toEqual(["192.168.50.10"])
  })

  it("falls back gracefully when createDataChannel throws", async () => {
    class Throwy extends FakePeerConnection {
      constructor(c: RTCConfiguration) {
        super(c)
        this.createDataChannelFails = true
      }
    }
    const promise = getPrivateLocalIps({
      rtcImpl: Throwy as unknown as typeof RTCPeerConnection,
      timeoutMs: 5_000,
    })
    await Promise.resolve()
    const pc = FakePeerConnection.instances.at(-1)!
    pc.emit("candidate:0 1 UDP 2122252543 172.16.0.7 50000 typ host")
    pc.finishGathering()
    expect(await promise).toEqual(["172.16.0.7"])
  })

  it("resolves [] when createOffer rejects", async () => {
    class Throwy extends FakePeerConnection {
      constructor(c: RTCConfiguration) {
        super(c)
        this.createOfferFails = true
      }
    }
    const result = await getPrivateLocalIps({
      rtcImpl: Throwy as unknown as typeof RTCPeerConnection,
      timeoutMs: 5_000,
    })
    expect(result).toEqual([])
  })

  it("resolves [] when the constructor throws", async () => {
    class Throwy {
      constructor() {
        throw new Error("blocked")
      }
    }
    const result = await getPrivateLocalIps({
      rtcImpl: Throwy as unknown as typeof RTCPeerConnection,
      timeoutMs: 5_000,
    })
    expect(result).toEqual([])
  })

  it("resolves at the timeout when no candidates arrive", async () => {
    jest.useFakeTimers()
    const promise = getPrivateLocalIps({
      rtcImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      timeoutMs: 250,
    })
    await Promise.resolve() // let constructor run
    jest.advanceTimersByTime(250)
    const result = await promise
    expect(result).toEqual([])
    jest.useRealTimers()
  })

  it("resolves [] mid-flight when the signal aborts", async () => {
    const controller = new AbortController()
    const promise = getPrivateLocalIps({
      rtcImpl: FakePeerConnection as unknown as typeof RTCPeerConnection,
      signal: controller.signal,
      timeoutMs: 5_000,
    })
    await Promise.resolve()
    controller.abort()
    expect(await promise).toEqual([])
  })
})
