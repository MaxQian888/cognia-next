/**
 * TransportRtc unit tests — mocks `RTCPeerConnection` and `SignalingClient`
 * so the negotiation/RPC/event paths are exercised deterministically.
 */

import { TransportRtc, type RtcMessage, type RtcResponse } from "./transport-rtc"
import type {
  Envelope,
  PeerRole,
  RtcAnswerBody,
  RtcIceBody,
  SignalingClient,
} from "@/lib/signaling"

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

// ---------------------------------------------------------------------------
// Mock SignalingClient
// ---------------------------------------------------------------------------

type Listeners = {
  state: Set<(s: string) => void>
  envelope: Set<(p: { fromRole: PeerRole; envelope: Envelope }) => void>
  error: Set<(p: { code: string; message: string }) => void>
  peerJoined: Set<(r: PeerRole) => void>
  peerLeft: Set<(r: PeerRole) => void>
}

class FakeSignaling {
  readonly sent: Array<{ kind: string; body: unknown }> = []
  readonly listeners: Listeners = {
    state: new Set(),
    envelope: new Set(),
    error: new Set(),
    peerJoined: new Set(),
    peerLeft: new Set(),
  }
  closed = false

  on<K extends keyof Listeners>(
    event: K,
    listener: (...args: Parameters<Parameters<Listeners[K]["add"]>[0]>) => void
  ): () => void {
    ;(this.listeners[event] as Set<unknown>).add(listener as unknown)
    return () => {
      ;(this.listeners[event] as Set<unknown>).delete(listener as unknown)
    }
  }
  connect(): void {
    // Synthetic "subscribed" once connect() is called.
    queueMicrotask(() => {
      for (const l of this.listeners.state) l("subscribed")
    })
  }
  async send(kind: string, body: unknown): Promise<void> {
    this.sent.push({ kind, body })
  }
  close(): void {
    this.closed = true
  }
  emitEnvelope(envelope: Envelope, fromRole: PeerRole = "desktop"): void {
    for (const l of this.listeners.envelope) l({ fromRole, envelope })
  }
  emitError(code: string, message = ""): void {
    for (const l of this.listeners.error) l({ code, message })
  }
}

// ---------------------------------------------------------------------------
// Mock RTCPeerConnection / RTCDataChannel
// ---------------------------------------------------------------------------

class FakeDataChannel {
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting"
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  readonly sent: string[] = []
  constructor(public label: string) {}
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = "closed"
    this.onclose?.()
  }
  open(): void {
    this.readyState = "open"
    this.onopen?.()
  }
  push(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
  }
}

class FakePeerConnection {
  iceConnectionState: RTCIceConnectionState = "new"
  connectionState: RTCPeerConnectionState = "new"
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => void) | null = null
  oniceconnectionstatechange: (() => void) | null = null
  onconnectionstatechange: (() => void) | null = null

  channels: FakeDataChannel[] = []
  remoteDescription: RTCSessionDescriptionInit | null = null
  iceCandidates: RTCIceCandidateInit[] = []
  /** Stats entries injected by tests for `getSelectedCandidateKind`. */
  statsEntries: Array<Record<string, unknown>> = []
  /** Set to true to make `getStats()` reject. */
  statsThrows = false

  createDataChannel(label: string): FakeDataChannel {
    const dc = new FakeDataChannel(label)
    this.channels.push(dc)
    return dc as unknown as FakeDataChannel
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "v=0\r\nmock-offer" }
  }
  async setLocalDescription(_d: RTCSessionDescriptionInit): Promise<void> {}
  async setRemoteDescription(d: RTCSessionDescriptionInit): Promise<void> {
    this.remoteDescription = d
  }
  async addIceCandidate(c: RTCIceCandidateInit): Promise<void> {
    this.iceCandidates.push(c)
  }
  async getStats(): Promise<RTCStatsReport> {
    if (this.statsThrows) throw new Error("getStats failed")
    const entries = this.statsEntries
    return {
      forEach(cb: (value: Record<string, unknown>, key: string) => void): void {
        for (const e of entries) cb(e, String(e.id ?? ""))
      },
    } as unknown as RTCStatsReport
  }
  close(): void {
    this.connectionState = "closed"
  }
  fireIceCandidate(candidate: RTCIceCandidateInit | null): void {
    const event = {
      candidate: candidate ? ({ toJSON: () => candidate } as unknown as RTCIceCandidate) : null,
    } as RTCPeerConnectionIceEvent
    this.onicecandidate?.(event)
  }
  setIceState(s: RTCIceConnectionState): void {
    this.iceConnectionState = s
    this.oniceconnectionstatechange?.()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envelope(kind: Envelope["kind"], body: unknown, seq = 1): Envelope {
  return {
    ver: 1,
    ts: Date.now(),
    nonce: "n",
    seq,
    kind,
    body,
    mac: "",
  }
}

function makeRtc() {
  const sig = new FakeSignaling()
  const pcs: FakePeerConnection[] = []
  const rtc = new TransportRtc({
    signalingUrl: "wss://signaling.test/v1/signaling",
    rendezvousId: "room-1",
    rendezvousSecret: SECRET,
    deviceId: "dev-1",
    role: "mobile",
    peerConnectionFactory: () => {
      const pc = new FakePeerConnection()
      pcs.push(pc)
      return pc as unknown as RTCPeerConnection
    },
    signalingClientFactory: () => sig as unknown as SignalingClient,
  })
  return { rtc, sig, pcs }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TransportRtc", () => {
  it("performs SDP/ICE exchange and opens the DataChannel", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()

    // Let the FakeSignaling fire `state=subscribed` → startNegotiation.
    await new Promise((r) => setTimeout(r, 5))
    expect(pcs.length).toBe(1)
    expect(sig.sent.some((m) => m.kind === "rtc:offer")).toBe(true)

    // Server replies with an answer + ICE candidate.
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "v=0\r\nmock-answer" } as RtcAnswerBody))
    sig.emitEnvelope(envelope("rtc:ice", { candidate: { candidate: "" } } as RtcIceBody))
    await new Promise((r) => setTimeout(r, 5))
    expect(pcs[0].remoteDescription?.sdp).toBe("v=0\r\nmock-answer")
    expect(pcs[0].iceCandidates).toHaveLength(1)

    // DataChannel opens → connect resolves.
    pcs[0].channels[0].open()
    await connect
    expect(rtc.getState()).toBe("open")
  })

  it("forwards local ICE candidates through signaling", async () => {
    const { rtc, sig, pcs } = makeRtc()
    void rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    pcs[0].fireIceCandidate({ candidate: "candidate:1 1 udp" } as RTCIceCandidateInit)
    expect(sig.sent.some((m) => m.kind === "rtc:ice")).toBe(true)
  })

  it("call() round-trips an RPC over the DataChannel", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const pending = rtc.call<{ count: number }>("ping", { n: 1 })
    const dc = pcs[0].channels[0]
    // Inspect the sent envelope.
    const sent = JSON.parse(dc.sent[0]) as RtcMessage
    expect(sent.method).toBe("ping")
    // Server replies.
    dc.push({ id: sent.id, ok: true, result: { count: 42 } } satisfies RtcResponse)
    const result = await pending
    expect(result).toEqual({ count: 42 })
  })

  it("dispatches inbound events to subscribers", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const received: unknown[] = []
    rtc.subscribe("topic", (p) => received.push(p))
    pcs[0].channels[0].push({
      kind: "event",
      event: "topic",
      seq: 5,
      payload: { hello: "world" },
    })
    expect(received).toEqual([{ hello: "world" }])
    expect(rtc.getSeqCursor()).toEqual({ topic: 5 })
  })

  it("negotiation timeout transitions to failed and rejects connect", async () => {
    jest.useFakeTimers()
    const { rtc } = makeRtc()
    const connect = rtc.connect()
    // Drive past the negotiation timeout (default 8s).
    await Promise.resolve()
    jest.advanceTimersByTime(8500)
    await expect(connect).rejects.toThrow(/timed out/i)
    expect(rtc.getState()).toBe("failed")
    jest.useRealTimers()
  })

  it("ICE failure tears down to failed", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    pcs[0].setIceState("failed")
    expect(rtc.getState()).toBe("failed")
  })

  it("close() shuts down signaling and pending RPCs", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const pending = rtc.call("never-replies")
    rtc.close()
    await expect(pending).rejects.toThrow(/closing/i)
    expect(rtc.getState()).toBe("closed")
    expect(sig.closed).toBe(true)
  })

  it("call() rejects when DataChannel isn't open yet", async () => {
    const { rtc } = makeRtc()
    await expect(rtc.call("anything")).rejects.toThrow(/not open/i)
  })

  describe("getSelectedCandidateKind", () => {
    async function openRtc(): Promise<{ rtc: TransportRtc; pc: FakePeerConnection }> {
      const { rtc, sig, pcs } = makeRtc()
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
      pcs[0].channels[0].open()
      await connect
      return { rtc, pc: pcs[0] }
    }

    it("returns 'unknown' when the data channel is not open", async () => {
      const { rtc } = makeRtc()
      expect(await rtc.getSelectedCandidateKind()).toBe("unknown")
    })

    it("returns 'host' when the selected pair is a host candidate", async () => {
      const { rtc, pc } = await openRtc()
      pc.statsEntries = [
        {
          type: "candidate-pair",
          id: "pair-1",
          selected: true,
          nominated: true,
          state: "succeeded",
          localCandidateId: "local-1",
        },
        { type: "local-candidate", id: "local-1", candidateType: "host" },
      ]
      expect(await rtc.getSelectedCandidateKind()).toBe("host")
    })

    it("returns 'relay' for a TURN-routed pair", async () => {
      const { rtc, pc } = await openRtc()
      pc.statsEntries = [
        {
          type: "candidate-pair",
          id: "pair-1",
          nominated: true,
          state: "succeeded",
          localCandidateId: "local-1",
        },
        { type: "local-candidate", id: "local-1", candidateType: "relay" },
      ]
      expect(await rtc.getSelectedCandidateKind()).toBe("relay")
    })

    it("returns 'srflx' for a server-reflexive selection", async () => {
      const { rtc, pc } = await openRtc()
      pc.statsEntries = [
        {
          type: "candidate-pair",
          id: "pair-1",
          selected: true,
          nominated: true,
          state: "succeeded",
          localCandidateId: "local-1",
        },
        { type: "local-candidate", id: "local-1", candidateType: "srflx" },
      ]
      expect(await rtc.getSelectedCandidateKind()).toBe("srflx")
    })

    it("returns 'unknown' when no pair has been nominated", async () => {
      const { rtc, pc } = await openRtc()
      pc.statsEntries = [
        {
          type: "candidate-pair",
          id: "pair-1",
          nominated: false,
          state: "in-progress",
          localCandidateId: "local-1",
        },
        { type: "local-candidate", id: "local-1", candidateType: "host" },
      ]
      expect(await rtc.getSelectedCandidateKind()).toBe("unknown")
    })

    it("returns 'unknown' when getStats() throws", async () => {
      const { rtc, pc } = await openRtc()
      pc.statsThrows = true
      expect(await rtc.getSelectedCandidateKind()).toBe("unknown")
    })

    it("returns 'unknown' when the local-candidate row is missing", async () => {
      const { rtc, pc } = await openRtc()
      pc.statsEntries = [
        {
          type: "candidate-pair",
          id: "pair-1",
          selected: true,
          nominated: true,
          state: "succeeded",
          localCandidateId: "missing-id",
        },
      ]
      expect(await rtc.getSelectedCandidateKind()).toBe("unknown")
    })
  })
})
