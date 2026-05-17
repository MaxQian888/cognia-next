/**
 * TransportRtc unit tests — mocks `RTCPeerConnection` and `SignalingClient`
 * so the negotiation/RPC/event paths are exercised deterministically.
 */

import {
  RECONNECT_BACKOFF_MS,
  TransportRtc,
  type RtcMessage,
  type RtcResponse,
} from "./transport-rtc"
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

  it("ICE failure mid-session schedules a reconnect (per ADR-0021 hardening)", async () => {
    // Before W1, ICE failure mid-session went straight to `failed`. The
    // mid-session-reconnect work changed that: the outer state machine
    // now treats it as a transient disconnect and schedules a fresh
    // handshake. The dedicated `mid-session reconnect` block below
    // covers the rest of the lifecycle.
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    pcs[0].setIceState("failed")
    expect(rtc.getState()).toBe("reconnecting")
    rtc.close()
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

  // ---------------------------------------------------------------------------
  // Mid-session reconnect (ADR-0021 hardening) — W1
  // ---------------------------------------------------------------------------

  describe("mid-session reconnect", () => {
    function makeReconnectable(reconnectBackoffMs: readonly number[] = [5, 10, 20]) {
      const sigs: FakeSignaling[] = []
      const pcs: FakePeerConnection[] = []
      const rtc = new TransportRtc({
        signalingUrl: "wss://signaling.test/v1/signaling",
        rendezvousId: "room-1",
        rendezvousSecret: SECRET,
        deviceId: "dev-1",
        role: "mobile",
        reconnectBackoffMs,
        peerConnectionFactory: () => {
          const pc = new FakePeerConnection()
          pcs.push(pc)
          return pc as unknown as RTCPeerConnection
        },
        signalingClientFactory: () => {
          const sig = new FakeSignaling()
          sigs.push(sig)
          return sig as unknown as SignalingClient
        },
      })
      return { rtc, sigs, pcs }
    }

    async function drivePeerOpen(sigs: FakeSignaling[], pcs: FakePeerConnection[]): Promise<void> {
      // queueMicrotask in FakeSignaling.connect + the offer/setLocalDescription
      // awaits all flush within a short real-timer wait.
      await new Promise((r) => setTimeout(r, 5))
      const i = pcs.length - 1
      sigs[sigs.length - 1].emitEnvelope(
        envelope("rtc:answer", { sdp: "v=0\r\nmock-answer" } as RtcAnswerBody)
      )
      await new Promise((r) => setTimeout(r, 5))
      pcs[i].channels[0].open()
      await new Promise((r) => setTimeout(r, 0))
    }

    it("RECONNECT_BACKOFF_MS is monotonically increasing and caps at 60s", () => {
      expect(RECONNECT_BACKOFF_MS.length).toBeGreaterThanOrEqual(5)
      for (let i = 1; i < RECONNECT_BACKOFF_MS.length; i++) {
        expect(RECONNECT_BACKOFF_MS[i]).toBeGreaterThan(RECONNECT_BACKOFF_MS[i - 1])
      }
      expect(RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]).toBe(60_000)
      expect(RECONNECT_BACKOFF_MS[0]).toBe(1_000)
    })

    it("mid-session DataChannel.close transitions to 'reconnecting' (not 'failed')", async () => {
      const { rtc, sigs, pcs } = makeReconnectable()
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect
      expect(rtc.getState()).toBe("open")

      pcs[0].channels[0].close()
      expect(rtc.getState()).toBe("reconnecting")
    })

    it("schedules a fresh handshake after the configured backoff", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([10, 20])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      pcs[0].channels[0].close()
      expect(rtc.getState()).toBe("reconnecting")
      expect(pcs.length).toBe(1)
      expect(sigs.length).toBe(1)

      // Wait for first backoff (10ms) + microtask drain.
      await new Promise((r) => setTimeout(r, 20))

      // A new peer + signaling pair must have been created.
      expect(pcs.length).toBe(2)
      expect(sigs.length).toBe(2)
      // The new cycle sent a fresh offer over the new signaling instance.
      expect(sigs[1].sent.some((m) => m.kind === "rtc:offer")).toBe(true)
    })

    it("successful reconnect resets the attempt counter", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([5, 50, 500])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      // First drop → backoff tier 0 (5ms).
      pcs[0].channels[0].close()
      await new Promise((r) => setTimeout(r, 15))
      // Second cycle's DC opens.
      await drivePeerOpen(sigs, pcs)
      expect(rtc.getState()).toBe("open")

      // Second drop should again use tier 0 (5ms). If the counter had not
      // reset, this drop would schedule for 50ms and the assertion below
      // would fail.
      pcs[1].channels[0].close()
      await new Promise((r) => setTimeout(r, 15))
      expect(pcs.length).toBe(3)
    })

    it("zero-length backoff schedule fails immediately on first drop", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      pcs[0].channels[0].close()
      expect(rtc.getState()).toBe("failed")
    })

    it("close() during reconnect cancels the backoff timer", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([200])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      pcs[0].channels[0].close()
      expect(rtc.getState()).toBe("reconnecting")

      rtc.close()
      expect(rtc.getState()).toBe("closed")

      // Wait past the would-be backoff and assert no new peer was created.
      await new Promise((r) => setTimeout(r, 250))
      expect(pcs.length).toBe(1)
      expect(sigs.length).toBe(1)
    })

    it("reconnectNow() from 'open' state bypasses backoff and reopens", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([10_000])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      expect(rtc.reconnectNow()).toBe(true)
      // Should NOT wait the 10s backoff; new peer is created immediately.
      await new Promise((r) => setTimeout(r, 5))
      expect(pcs.length).toBe(2)
      expect(sigs.length).toBe(2)
    })

    it("reconnectNow() from 'reconnecting' state cancels the pending timer", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([10_000])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      pcs[0].channels[0].close()
      expect(rtc.getState()).toBe("reconnecting")

      expect(rtc.reconnectNow()).toBe(true)
      // Cycle 2 should start without waiting the 10s backoff.
      await new Promise((r) => setTimeout(r, 5))
      expect(pcs.length).toBe(2)
    })

    it("reconnectNow() from 'failed' state restarts the connection", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      pcs[0].channels[0].close()
      expect(rtc.getState()).toBe("failed")

      expect(rtc.reconnectNow()).toBe(true)
      await new Promise((r) => setTimeout(r, 5))
      expect(pcs.length).toBe(2)
      expect(sigs.length).toBe(2)
    })

    it("reconnectNow() during in-flight negotiation is a no-op", async () => {
      const { rtc, sigs, pcs } = makeReconnectable()
      void rtc.connect()
      // Wait just past queueMicrotask so state=negotiating.
      await new Promise((r) => setTimeout(r, 5))
      const pcsBefore = pcs.length
      const sigsBefore = sigs.length
      // First call: throttle was empty, returns true but state guard
      // keeps the existing cycle alive.
      expect(rtc.reconnectNow()).toBe(true)
      await new Promise((r) => setTimeout(r, 5))
      // No fresh peer/signaling were created — the existing in-flight
      // attempt is allowed to settle.
      expect(pcs.length).toBe(pcsBefore)
      expect(sigs.length).toBe(sigsBefore)
    })

    it("reconnectNow() throttles repeated calls within the 5s window", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([10_000])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      // First call fires.
      expect(rtc.reconnectNow()).toBe(true)
      // Second call within the spacing window is rejected — no new peer
      // beyond the one the first reconnect created.
      expect(rtc.reconnectNow()).toBe(false)
      await new Promise((r) => setTimeout(r, 10))
      // The first reconnect produced cycle 2; the throttled call must
      // not have started cycle 3.
      expect(pcs.length).toBeLessThanOrEqual(2)
    })

    it("ICE failure mid-session triggers reconnect, not failed", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([1000])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      pcs[0].setIceState("failed")
      expect(rtc.getState()).toBe("reconnecting")
    })

    it("ICE failure during negotiation goes to failed (not reconnect)", async () => {
      const { rtc, sigs, pcs } = makeReconnectable()
      // connect() will reject when fail() runs — swallow it so the
      // unhandled-rejection guard doesn't fail the test.
      const connect = rtc.connect().catch(() => undefined)
      await new Promise((r) => setTimeout(r, 5))
      // We are in 'negotiating' state — ICE failure here is a hard fail.
      pcs[0].setIceState("failed")
      expect(rtc.getState()).toBe("failed")
      await connect
      // No reconnect was scheduled (sigs/pcs counts unchanged after delay).
      await new Promise((r) => setTimeout(r, 20))
      expect(pcs.length).toBe(1)
      expect(sigs.length).toBe(1)
    })

    it("pending RPCs reject with a 'reset' error when reconnecting", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([1000])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      const pending = rtc.call("never-replies")
      pcs[0].channels[0].close()
      await expect(pending).rejects.toThrow(/reset/i)
      expect(rtc.getState()).toBe("reconnecting")
    })
  })
})
