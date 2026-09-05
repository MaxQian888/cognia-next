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
  PeerSnapshot,
  RtcAnswerBody,
  RtcIceBody,
  SignalingClient,
} from "@/lib/signaling"
import { remoteEventResyncCoordinator } from "./resync-coordinator"

const ROOM_DESCRIPTOR = {
  v: 2 as const,
  roomId: "room-1",
  roomNonce: "nonce",
  desktopSigningKey: "desktop-key",
  mobileSigningKey: "mobile-key",
  notAfter: Number.MAX_SAFE_INTEGER,
}
const SIGNALING_PRIVATE_KEY = {} as CryptoKey

// ---------------------------------------------------------------------------
// Mock SignalingClient
// ---------------------------------------------------------------------------

type Listeners = {
  state: Set<(s: string) => void>
  subscribed: Set<(p: { peers: PeerSnapshot[] }) => void>
  envelope: Set<(p: { fromRole: PeerRole; envelope: Envelope }) => void>
  error: Set<(p: { code: string; message: string }) => void>
  peerJoined: Set<(r: PeerRole) => void>
  peerLeft: Set<(r: PeerRole) => void>
}

const DESKTOP_PRESENT: PeerSnapshot[] = [
  {
    proof: {
      v: 2,
      roomId: "room-1",
      role: "desktop",
      sessionId: "desktop-session",
      epoch: "desktop-epoch",
      issuedAt: 0,
      challenge: "challenge",
      ecdhPublicKey: "key",
      signature: "signature",
    },
    joinedAtMs: 0,
  },
]

class FakeSignaling {
  readonly sent: Array<{ kind: string; body: unknown }> = []
  readonly listeners: Listeners = {
    state: new Set(),
    subscribed: new Set(),
    envelope: new Set(),
    error: new Set(),
    peerJoined: new Set(),
    peerLeft: new Set(),
  }
  closed = false
  sendError: Error | null = null

  /**
   * Peers reported in the synthetic `subscribed` frame on connect(). Defaults
   * to a desktop already in the room, mirroring the common case (desktop
   * signaling client subscribes at boot). Cold-start-race tests set `[]` and
   * then drive `emitPeerJoined("desktop")` to prove the F1 wait behaviour.
   */
  peersOnSubscribe: PeerSnapshot[] = DESKTOP_PRESENT

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
    // Synthetic subscribe once connect() is called: flip the WSS state AND
    // surface the room occupancy the way the real client does.
    queueMicrotask(() => {
      for (const l of this.listeners.state) l("subscribed")
      for (const l of this.listeners.subscribed) l({ peers: this.peersOnSubscribe })
    })
  }
  async send(kind: string, body: unknown): Promise<void> {
    this.sent.push({ kind, body })
    if (this.sendError) throw this.sendError
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
  emitPeerJoined(role: PeerRole = "desktop"): void {
    for (const l of this.listeners.peerJoined) l(role)
  }
  emitPeerLeft(role: PeerRole = "desktop"): void {
    for (const l of this.listeners.peerLeft) l(role)
  }
}

// ---------------------------------------------------------------------------
// Mock RTCPeerConnection / RTCDataChannel
// ---------------------------------------------------------------------------

class FakeDataChannel {
  readyState: "connecting" | "open" | "closing" | "closed" = "connecting"
  readonly ordered = true
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  binaryType: BinaryType = "blob"
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
  pushBinary(data: ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent)
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
  configuration: RTCConfiguration | undefined
  /** Set to true to make `getStats()` reject. */
  statsThrows = false

  createDataChannel(label: string): FakeDataChannel {
    const dc = new FakeDataChannel(label)
    this.channels.push(dc)
    return dc as unknown as FakeDataChannel
  }

  /** Options passed to each createOffer call (tests assert ICE restart). */
  offerOptions: Array<RTCOfferOptions | undefined> = []
  async createOffer(options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    this.offerOptions.push(options)
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
  setConfiguration(configuration: RTCConfiguration): void {
    this.configuration = configuration
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

const activeRtcs = new Set<TransportRtc>()

afterEach(() => {
  for (const rtc of activeRtcs) rtc.close()
  activeRtcs.clear()
})

function envelope(kind: Envelope["kind"], body: unknown, seq = 1): Envelope {
  return {
    ver: 2,
    roomId: "room-1",
    senderRole: "desktop",
    sessionId: "desktop-session",
    epoch: "desktop-epoch",
    seq,
    issuedAt: Date.now(),
    kind,
    body,
  }
}

function makeRtc(
  overrides: Partial<
    Pick<
      ConstructorParameters<typeof TransportRtc>[0],
      "peerWaitTimeoutMs" | "negotiationTimeoutMs" | "disconnectedGraceMs"
    >
  > = {}
) {
  const sig = new FakeSignaling()
  const pcs: FakePeerConnection[] = []
  const rtc = new TransportRtc({
    signalingUrl: "wss://signaling.test/signaling",
    rendezvousId: "room-1",
    signalingRoomDescriptor: ROOM_DESCRIPTOR,
    signalingPrivateKey: SIGNALING_PRIVATE_KEY,
    deviceId: "dev-1",
    role: "mobile",
    peerConnectionFactory: () => {
      const pc = new FakePeerConnection()
      pcs.push(pc)
      return pc as unknown as RTCPeerConnection
    },
    signalingClientFactory: () => sig as unknown as SignalingClient,
    ...overrides,
  })
  activeRtcs.add(rtc)
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

  it("handles a rejected fire-and-forget ICE send without an unhandled rejection", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
    const { rtc, sig, pcs } = makeRtc()
    void rtc.connect()
    await new Promise((resolve) => setTimeout(resolve, 5))
    sig.sendError = new Error("queue full")

    pcs[0].fireIceCandidate({ candidate: "candidate:1 1 udp 1 127.0.0.1 9 typ host" })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(warn).toHaveBeenCalledWith(
      "TransportRtc: failed to queue local ICE candidate",
      sig.sendError
    )
    warn.mockRestore()
  })

  it("negotiates a separate ordered terminal channel with the canonical label", async () => {
    const { rtc, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((resolve) => setTimeout(resolve, 5))

    expect(pcs[0].channels.map((channel) => channel.label)).toEqual([
      "cognia.signaling",
      "cognia.terminal",
    ])
    expect(rtc.getTerminalDataChannel()).toBe(pcs[0].channels[1])

    pcs[0].channels[0].open()
    await connect
  })

  // ADR-0021 F1 — cold-start race. Before the fix, the mobile sent its offer
  // the instant it subscribed; when the desktop hadn't joined the rendezvous
  // yet, the signaling server dropped the offer into an empty room and the
  // whole cold-start stalled until the 8 s negotiation timer fired.
  describe("cold-start peer wait (F1)", () => {
    it("holds in 'awaiting-peer' — no offer — when the room is empty on subscribe", async () => {
      const { rtc, sig, pcs } = makeRtc()
      sig.peersOnSubscribe = [] // desktop not in the rendezvous yet
      void rtc.connect()
      await new Promise((r) => setTimeout(r, 5))

      expect(rtc.getState()).toBe("awaiting-peer")
      // Critically: NO offer was fired into the empty room, and no peer
      // connection was even constructed.
      expect(sig.sent.some((m) => m.kind === "rtc:offer")).toBe(false)
      expect(pcs.length).toBe(0)
      rtc.close()
    })

    it("starts negotiating the moment the desktop peer joins", async () => {
      const { rtc, sig, pcs } = makeRtc()
      sig.peersOnSubscribe = []
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("awaiting-peer")

      // Desktop's signaling client subscribes → server relays peerJoined.
      sig.emitPeerJoined("desktop")
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("negotiating")
      expect(pcs.length).toBe(1)
      expect(sig.sent.some((m) => m.kind === "rtc:offer")).toBe(true)

      // Handshake completes normally.
      sig.emitEnvelope(envelope("rtc:answer", { sdp: "v=0\r\nmock-answer" } as RtcAnswerBody))
      pcs[0].channels[0].open()
      await connect
      expect(rtc.getState()).toBe("open")
    })

    it("negotiates immediately when the desktop is already in the room on subscribe", async () => {
      const { rtc, sig } = makeRtc()
      // Default peersOnSubscribe already lists the desktop.
      void rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("negotiating")
      expect(sig.sent.some((m) => m.kind === "rtc:offer")).toBe(true)
      rtc.close()
    })

    it("does NOT arm the negotiation timeout while awaiting a peer; fails only after the peer-wait window", async () => {
      // Real timers with short windows: the negotiation timeout (30ms) is
      // SHORTER than the peer-wait window (150ms). If the negotiation timer
      // were (wrongly) armed at subscribe time, we'd fail at ~30ms; instead we
      // must stay in `awaiting-peer` until the peer-wait window elapses.
      const { rtc, sig } = makeRtc({ negotiationTimeoutMs: 30, peerWaitTimeoutMs: 150 })
      sig.peersOnSubscribe = []
      const connect = rtc.connect()
      connect.catch(() => undefined)
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("awaiting-peer")

      // Past the negotiation timeout, well before the peer-wait window.
      await new Promise((r) => setTimeout(r, 60))
      expect(rtc.getState()).toBe("awaiting-peer")

      // Past the peer-wait window → fails over so the caller can drop to WS.
      await new Promise((r) => setTimeout(r, 120))
      expect(rtc.getState()).toBe("failed")
    })

    it("peerLeft before the channel opens fails fast (F7)", async () => {
      const { rtc, sig } = makeRtc()
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("negotiating")
      // Desktop drops mid-handshake — don't wait out the negotiation timer.
      sig.emitPeerLeft("desktop")
      await expect(connect).rejects.toThrow(/peer left the rendezvous/i)
      expect(rtc.getState()).toBe("failed")
    })
  })

  it("forwards local ICE candidates through signaling", async () => {
    const { rtc, sig, pcs } = makeRtc({ disconnectedGraceMs: 0 })
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
    const sent = dc.sent
      .map((raw) => JSON.parse(raw) as RtcMessage)
      .find((frame) => typeof frame.id === "string")!
    expect(sent.method).toBe("ping")
    // Server replies.
    dc.push({ id: sent.id, ok: true, result: { count: 42 } } satisfies RtcResponse)
    const result = await pending
    expect(result).toEqual({ count: 42 })
  })

  it("readBinary() reassembles raw resource chunks without JSON/base64", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((resolve) => setTimeout(resolve, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const dc = pcs[0].channels[0]
    const pending = rtc.readBinary({
      kind: "session-media",
      sessionId: "s1",
      hash: "a".repeat(64),
      variant: "canonical",
    })
    const request = dc.sent
      .map((raw) => JSON.parse(raw) as { kind?: string; id?: string })
      .find((frame) => frame.kind === "binary-resource")!
    expect(dc.binaryType).toBe("arraybuffer")
    dc.push({
      kind: "binary-resource-start",
      id: request.id,
      mediaType: "image/png",
      totalBytes: 4,
      totalChunks: 1,
    })
    const frame = new ArrayBuffer(48 + 4)
    const frameBytes = new Uint8Array(frame)
    frameBytes.set([0x43, 0x47, 0x4d, 0x31], 0)
    frameBytes.set(new TextEncoder().encode(request.id!), 4)
    const view = new DataView(frame)
    view.setUint32(40, 0)
    view.setUint32(44, 1)
    frameBytes.set([0, 255, 17, 99], 48)
    dc.pushBinary(frame)

    await expect(pending).resolves.toEqual({
      bytes: Uint8Array.from([0, 255, 17, 99]),
      mediaType: "image/png",
    })
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
    expect(pcs[0].channels[0].sent.map((raw) => JSON.parse(raw))).toContainEqual({
      kind: "event-ack",
      seq: 5,
    })
  })

  it("surfaces an explicit resync requirement to every registered event domain", async () => {
    const resolveSnapshot = jest.fn(async () => {})
    const removeResolver = remoteEventResyncCoordinator.register("topic", resolveSnapshot)
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((resolve) => setTimeout(resolve, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const received: unknown[] = []
    rtc.subscribe("topic", (payload) => received.push(payload))
    pcs[0].channels[0].push({
      kind: "resync_required",
      domains: ["topic"],
      cursor: 7,
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(resolveSnapshot).toHaveBeenCalledTimes(1)
    expect(received).toEqual([{ type: "resync_required", domains: ["topic"] }])
    expect(pcs[0].channels[0].sent.map((raw) => JSON.parse(raw))).toContainEqual({
      kind: "event-resume",
      since: 0,
    })
    expect(pcs[0].channels[0].sent.map((raw) => JSON.parse(raw))).toContainEqual({
      kind: "event-ack",
      seq: 7,
    })
    removeResolver()
  })

  it("does not dispatch duplicate or out-of-order events", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const received: unknown[] = []
    rtc.subscribe("topic", (payload) => received.push(payload))
    const dc = pcs[0].channels[0]
    dc.push({ kind: "event", event: "topic", seq: 5, payload: "fresh" })
    dc.push({ kind: "event", event: "topic", seq: 5, payload: "duplicate" })
    dc.push({ kind: "event", event: "topic", seq: 4, payload: "stale" })

    expect(received).toEqual(["fresh"])
    expect(rtc.getSeqCursor()).toEqual({ topic: 5 })
  })

  // ADR-0127 §2: `event-batch` frames expand into the single-event path
  // (seq cursor, dedupe) exactly like lone `event` frames.
  it("expands an event-batch envelope through the same cursor and dedupe path", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const received: unknown[] = []
    rtc.subscribe("topic", (payload) => received.push(payload))
    const dc = pcs[0].channels[0]
    dc.push({ kind: "event", event: "topic", seq: 2, payload: "lone" })
    dc.push({
      kind: "event-batch",
      event: "topic",
      seq_from: 2,
      seq_to: 5,
      frames: [
        { kind: "event", event: "topic", seq: 2, payload: "dup" },
        { kind: "event", event: "topic", seq: 3, payload: "b3" },
        { kind: "event", event: "topic", seq: 4, payload: "b4" },
        { kind: "event", event: "topic", seq: 5, payload: "b5" },
      ],
    })
    dc.push({ kind: "event", event: "topic", seq: 4, payload: "stale" })

    expect(received).toEqual(["lone", "b3", "b4", "b5"])
    expect(rtc.getSeqCursor()).toEqual({ topic: 5 })
    rtc.close()
  })

  it("queues remote ICE until the answer has been applied", async () => {
    const { rtc, sig, pcs } = makeRtc()
    void rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    const candidate = { candidate: "candidate:remote 1 udp" } as RTCIceCandidateInit

    sig.emitEnvelope(envelope("rtc:ice", { candidate } as RtcIceBody))
    await new Promise((r) => setTimeout(r, 0))
    expect(pcs[0].iceCandidates).toEqual([])

    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    await new Promise((r) => setTimeout(r, 0))
    expect(pcs[0].iceCandidates).toEqual([candidate])
    rtc.close()
  })

  it("serializes the idempotency key at the RPC top level", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const pending = rtc.call("mutate", { value: 1 }, { idempotencyKey: "idem-1" })
    const sent = pcs[0].channels[0].sent
      .map((raw) => JSON.parse(raw) as RtcMessage)
      .find((frame) => typeof frame.id === "string")!
    expect(sent).toMatchObject({
      method: "mutate",
      params: { value: 1 },
      idempotencyKey: "idem-1",
      protocolVersion: 2,
    })
    expect(sent.params).not.toHaveProperty("idempotencyKey")
    pcs[0].channels[0].push({ id: sent.id, ok: true, result: null } satisfies RtcResponse)
    await pending
  })

  it("negotiation timeout transitions to failed and rejects connect", async () => {
    jest.useFakeTimers()
    const { rtc } = makeRtc()
    const connect = rtc.connect()
    // Drive past the negotiation timeout (default 20s).
    await Promise.resolve()
    jest.advanceTimersByTime(20_500)
    await expect(connect).rejects.toThrow(/timed out/i)
    expect(rtc.getState()).toBe("failed")
    jest.useRealTimers()
  })

  it("applies refreshed TURN configuration to the live peer and future rebuilds", async () => {
    const { rtc, sig, pcs } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    const refreshed: RTCConfiguration = {
      iceServers: [
        {
          urls: "turns:turn.example.com:5349?transport=tcp",
          username: "ephemeral",
          credential: "rotated",
        },
      ],
    }
    rtc.updateRtcConfiguration(refreshed)

    expect(pcs[0].configuration).toEqual(refreshed)
  })

  it("ICE failure mid-session attempts an ICE restart before tearing down", async () => {
    // ICE restart (ADR-0021): a mid-session ICE failure first re-offers with
    // `iceRestart: true` on the SAME peer connection (preserving DTLS + the
    // data channel) rather than tearing everything down. The dedicated
    // "ICE restart" block below covers recovery / escalation. `makeRtc`
    // leaves iceRestartMaxAttempts at its default (2).
    const { rtc, sig, pcs } = makeRtc({ disconnectedGraceMs: 0 })
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    sig.emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
    pcs[0].channels[0].open()
    await connect

    pcs[0].setIceState("failed")
    await new Promise((r) => setTimeout(r, 5))
    // Stays open, re-offers with iceRestart on the SAME pc — no new peer.
    expect(rtc.getState()).toBe("open")
    expect(pcs.length).toBe(1)
    expect(pcs[0].offerOptions.some((o) => o?.iceRestart === true)).toBe(true)
    expect(sig.sent.filter((m) => m.kind === "rtc:offer")).toHaveLength(2)
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
    // Graceful shutdown: rtc:close is relayed best-effort, then the WS is
    // torn down once the signed frame settles.
    await new Promise((r) => setTimeout(r, 0))
    expect(sig.sent.some((m) => m.kind === "rtc:close")).toBe(true)
    expect(sig.closed).toBe(true)
  })

  it("announces identity with a hello envelope before the offer", async () => {
    const { rtc, sig } = makeRtc()
    void rtc.connect()
    await new Promise((r) => setTimeout(r, 5))
    const helloIdx = sig.sent.findIndex((m) => m.kind === "hello")
    const offerIdx = sig.sent.findIndex((m) => m.kind === "rtc:offer")
    expect(helloIdx).toBeGreaterThanOrEqual(0)
    expect(offerIdx).toBeGreaterThan(helloIdx)
    expect(sig.sent[helloIdx].body).toEqual({ deviceId: "dev-1", relay: true })
    rtc.close()
  })

  it("fails fast on a signaling error during negotiation (no 8s wait)", async () => {
    const { rtc, sig } = makeRtc()
    const connect = rtc.connect()
    await new Promise((r) => setTimeout(r, 5)) // reach 'negotiating'
    // A server error means a handshake frame was dropped — abort immediately
    // rather than stalling until the negotiation timeout.
    sig.emitError("rate_limited", "too many frames")
    await expect(connect).rejects.toThrow(/signaling error during negotiation/i)
    expect(rtc.getState()).toBe("failed")
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
        signalingUrl: "wss://signaling.test/signaling",
        rendezvousId: "room-1",
        signalingRoomDescriptor: ROOM_DESCRIPTOR,
        signalingPrivateKey: SIGNALING_PRIVATE_KEY,
        deviceId: "dev-1",
        role: "mobile",
        reconnectBackoffMs,
        reconnectRandom: () => 0.999_999,
        disconnectedGraceMs: 0,
        healthyResetMs: 0,
        // These tests exercise the full teardown/backoff ladder, so disable
        // the ICE-restart fast path — an ICE failure escalates straight to a
        // reconnect, matching the pre-ICE-restart behavior they assert.
        iceRestartMaxAttempts: 0,
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
      activeRtcs.add(rtc)
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

    it("RECONNECT_BACKOFF_MS is monotonically increasing and caps at 30s", () => {
      expect(RECONNECT_BACKOFF_MS.length).toBeGreaterThanOrEqual(5)
      for (let i = 1; i < RECONNECT_BACKOFF_MS.length; i++) {
        expect(RECONNECT_BACKOFF_MS[i]).toBeGreaterThan(RECONNECT_BACKOFF_MS[i - 1])
      }
      expect(RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]).toBe(30_000)
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

      expect(rtc.reconnectNow()).toBe("started")
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

      expect(rtc.reconnectNow()).toBe("started")
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

      expect(rtc.reconnectNow()).toBe("started")
      await new Promise((r) => setTimeout(r, 5))
      expect(pcs.length).toBe(2)
      expect(sigs.length).toBe(2)
    })

    it("reconnectNow() during in-flight negotiation returns 'busy' without a no-op restart (F3)", async () => {
      const { rtc, sigs, pcs } = makeReconnectable()
      void rtc.connect()
      // Wait just past queueMicrotask so state=negotiating.
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("negotiating")
      const pcsBefore = pcs.length
      const sigsBefore = sigs.length
      // ADR-0021 F3: an action is already in flight, so this reports 'busy'
      // (NOT the old 'true' that lied "reconnect started") and — crucially —
      // does not consume the throttle window.
      expect(rtc.reconnectNow()).toBe("busy")
      await new Promise((r) => setTimeout(r, 5))
      // No fresh peer/signaling were created — the existing in-flight
      // attempt is allowed to settle.
      expect(pcs.length).toBe(pcsBefore)
      expect(sigs.length).toBe(sigsBefore)
    })

    it("reconnectNow() 'busy' does not burn the throttle window (F3)", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([10_000])
      void rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("negotiating")
      // Click during negotiation → busy, throttle NOT consumed.
      expect(rtc.reconnectNow()).toBe("busy")
      // Let the handshake open.
      await drivePeerOpen(sigs, pcs)
      // A genuine reconnect from 'open' immediately after must still fire —
      // the earlier 'busy' must not have started the 5s throttle clock.
      expect(rtc.reconnectNow()).toBe("started")
      rtc.close()
    })

    it("reconnectNow() throttles repeated calls within the 5s window", async () => {
      const { rtc, sigs, pcs } = makeReconnectable([10_000])
      const connect = rtc.connect()
      await drivePeerOpen(sigs, pcs)
      await connect

      // First call fires and consumes the throttle window.
      expect(rtc.reconnectNow()).toBe("started")
      // Drive the fresh cycle back to 'open' so the SECOND call is evaluated
      // from a settled state — otherwise the in-flight handshake would report
      // 'busy' (which, by design, doesn't consume the throttle) and we'd never
      // reach the throttle branch.
      await drivePeerOpen(sigs, pcs)
      expect(rtc.getState()).toBe("open")
      // Second call within the 5s spacing window from a settled state → throttled.
      expect(rtc.reconnectNow()).toBe("throttled")
      await new Promise((r) => setTimeout(r, 10))
      // The throttled call must not have started cycle 3.
      expect(pcs.length).toBe(2)
      rtc.close()
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

  // ---------------------------------------------------------------------------
  // True ICE restart (ADR-0021) — renegotiate on the live peer
  // ---------------------------------------------------------------------------

  describe("ICE restart", () => {
    function makeIceRestartable(
      opts: {
        iceRestartTimeoutMs?: number
        iceRestartMaxAttempts?: number
        reconnectBackoffMs?: readonly number[]
        disconnectedGraceMs?: number
      } = {}
    ) {
      const sigs: FakeSignaling[] = []
      const pcs: FakePeerConnection[] = []
      const rtc = new TransportRtc({
        signalingUrl: "wss://signaling.test/signaling",
        rendezvousId: "room-1",
        signalingRoomDescriptor: ROOM_DESCRIPTOR,
        signalingPrivateKey: SIGNALING_PRIVATE_KEY,
        deviceId: "dev-1",
        role: "mobile",
        iceRestartTimeoutMs: opts.iceRestartTimeoutMs ?? 50,
        iceRestartMaxAttempts: opts.iceRestartMaxAttempts ?? 2,
        reconnectBackoffMs: opts.reconnectBackoffMs ?? [1000],
        disconnectedGraceMs: opts.disconnectedGraceMs ?? 0,
        healthyResetMs: 0,
        reconnectRandom: () => 0.999_999,
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
      activeRtcs.add(rtc)
      return { rtc, sigs, pcs }
    }

    async function open(sigs: FakeSignaling[], pcs: FakePeerConnection[]): Promise<void> {
      await new Promise((r) => setTimeout(r, 5))
      const i = pcs.length - 1
      sigs[sigs.length - 1].emitEnvelope(envelope("rtc:answer", { sdp: "x" } as RtcAnswerBody))
      await new Promise((r) => setTimeout(r, 5))
      pcs[i].channels[0].open()
      await new Promise((r) => setTimeout(r, 0))
    }

    it("re-offers with iceRestart on the same peer and stays open", async () => {
      const { rtc, sigs, pcs } = makeIceRestartable()
      const connect = rtc.connect()
      await open(sigs, pcs)
      await connect

      pcs[0].setIceState("failed")
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("open")
      expect(pcs).toHaveLength(1)
      expect(pcs[0].offerOptions.some((o) => o?.iceRestart === true)).toBe(true)
      // hello + initial offer + restart offer.
      expect(sigs[0].sent.filter((m) => m.kind === "rtc:offer")).toHaveLength(2)
      rtc.close()
    })

    it("cancels recovery when a transient disconnect heals within the 5s grace phase", async () => {
      const { rtc, sigs, pcs } = makeIceRestartable({ disconnectedGraceMs: 20 })
      const connect = rtc.connect()
      await open(sigs, pcs)
      await connect

      pcs[0].setIceState("disconnected")
      await new Promise((r) => setTimeout(r, 5))
      pcs[0].setIceState("connected")
      await new Promise((r) => setTimeout(r, 25))

      expect(pcs[0].offerOptions.some((o) => o?.iceRestart === true)).toBe(false)
      expect(rtc.getState()).toBe("open")
    })

    it("escalates to a full reconnect after the restart budget on a flapping link", async () => {
      const { rtc, sigs, pcs } = makeIceRestartable({ iceRestartMaxAttempts: 2 })
      const connect = rtc.connect()
      await open(sigs, pcs)
      await connect

      // Flap 1: failed → restart (attempt 1), then ICE recovers.
      pcs[0].setIceState("failed")
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("open")
      pcs[0].setIceState("connected")

      // Flap 2: failed → restart (attempt 2), then ICE recovers.
      pcs[0].setIceState("failed")
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("open")
      pcs[0].setIceState("connected")

      // Flap 3: budget exhausted → full teardown reconnect.
      pcs[0].setIceState("failed")
      expect(rtc.getState()).toBe("reconnecting")
      expect(pcs[0].offerOptions.filter((o) => o?.iceRestart === true)).toHaveLength(2)
      rtc.close()
    })

    it("escalates to a full reconnect when the ICE restart times out", async () => {
      const { rtc, sigs, pcs } = makeIceRestartable({
        iceRestartTimeoutMs: 20,
        reconnectBackoffMs: [10_000],
      })
      const connect = rtc.connect()
      await open(sigs, pcs)
      await connect

      pcs[0].setIceState("failed")
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("open") // restart in flight
      // No recovery → watchdog fires → full teardown → reconnecting.
      await new Promise((r) => setTimeout(r, 40))
      expect(rtc.getState()).toBe("reconnecting")
      rtc.close()
    })

    it("skips ICE restart entirely when iceRestartMaxAttempts is 0", async () => {
      const { rtc, sigs, pcs } = makeIceRestartable({ iceRestartMaxAttempts: 0 })
      const connect = rtc.connect()
      await open(sigs, pcs)
      await connect

      pcs[0].setIceState("failed")
      expect(rtc.getState()).toBe("reconnecting")
      expect(pcs[0].offerOptions.some((o) => o?.iceRestart === true)).toBe(false)
      rtc.close()
    })

    it("a fresh DataChannel open resets the restart budget", async () => {
      const { rtc, sigs, pcs } = makeIceRestartable({
        iceRestartMaxAttempts: 1,
        reconnectBackoffMs: [5],
      })
      const connect = rtc.connect()
      await open(sigs, pcs)
      await connect

      // Spend the budget (attempt 1), recover, then exhaust → full reconnect.
      pcs[0].setIceState("failed")
      await new Promise((r) => setTimeout(r, 5))
      pcs[0].setIceState("connected")
      pcs[0].setIceState("failed")
      expect(rtc.getState()).toBe("reconnecting")

      // The backoff reconnect opens a brand-new peer; its DC open resets the
      // budget so ICE restart is available again on the fresh peer.
      await open(sigs, pcs)
      expect(rtc.getState()).toBe("open")
      expect(pcs).toHaveLength(2)
      pcs[1].setIceState("failed")
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("open")
      expect(pcs[1].offerOptions.some((o) => o?.iceRestart === true)).toBe(true)
      rtc.close()
    })
  })
  describe("relay data lane (ADR-0170)", () => {
    const hostHello = (relay = true) => envelope("hello", { deviceId: "host", relay }, 1)

    it("opens over the relay the moment the Host acknowledges, before any DataChannel", async () => {
      const { rtc, sig, pcs } = makeRtc()
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      // hello went out first and carries the relay opt-in.
      expect(sig.sent[0]).toEqual({ kind: "hello", body: { deviceId: "dev-1", relay: true } })
      // ICE is in flight (P2P on by default) but nothing is open yet.
      expect(pcs).toHaveLength(1)
      expect(rtc.getState()).toBe("negotiating")
      expect(rtc.getCarrier()).toBeNull()

      sig.emitEnvelope(hostHello())
      await connect
      expect(rtc.getState()).toBe("open")
      expect(rtc.getCarrier()).toBe("relay")
      // The event cursor handshake went over the relay as a data envelope.
      const resume = sig.sent.find(
        (m) =>
          m.kind === "data" && String((m.body as { text?: string }).text).includes("event-resume")
      )
      expect(resume).toBeDefined()
      rtc.close()
    })

    it("carries an RPC as data envelopes and resolves from a relayed response", async () => {
      const { rtc, sig } = makeRtc()
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      sig.emitEnvelope(hostHello())
      await connect

      const call = rtc.call("sessions_list", { limit: 1 })
      await new Promise((r) => setTimeout(r, 5))
      const rpcFrame = sig.sent.find(
        (m) =>
          m.kind === "data" && String((m.body as { text?: string }).text).includes("sessions_list")
      )
      expect(rpcFrame).toBeDefined()
      const sent = JSON.parse((rpcFrame!.body as { text: string }).text) as { id: string }
      sig.emitEnvelope(
        envelope("data", { text: JSON.stringify({ id: sent.id, ok: true, result: [1] }) }, 2)
      )
      await expect(call).resolves.toEqual([1])
      rtc.close()
    })

    it("delivers relayed events and acks them on the same carrier", async () => {
      const { rtc, sig } = makeRtc()
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      sig.emitEnvelope(hostHello())
      await connect
      const received: unknown[] = []
      rtc.subscribe("claude://session-event", (payload) => received.push(payload))
      sig.emitEnvelope(
        envelope(
          "data",
          {
            text: JSON.stringify({
              kind: "event",
              event: "claude://session-event",
              seq: 7,
              payload: { hello: "relay" },
            }),
          },
          2
        )
      )
      expect(received).toEqual([{ hello: "relay" }])
      const ack = sig.sent.find(
        (m) => m.kind === "data" && String((m.body as { text?: string }).text).includes("event-ack")
      )
      expect(ack).toBeDefined()
      rtc.close()
    })

    it("promotes to the DataChannel when ICE completes and falls back when it drops", async () => {
      const { rtc, sig, pcs } = makeRtc({ reconnectBackoffMs: [5] } as never)
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      sig.emitEnvelope(hostHello())
      await connect
      expect(rtc.getCarrier()).toBe("relay")

      sig.emitEnvelope(envelope("rtc:answer", { sdp: "v=0\r\nmock-answer" } as RtcAnswerBody, 2))
      await new Promise((r) => setTimeout(r, 5))
      pcs[0].channels[0].open()
      expect(rtc.getState()).toBe("open")
      expect(rtc.getCarrier()).toBe("datachannel")

      // The DataChannel dies mid-session: still open, back on the relay, and a
      // fresh P2P attempt is scheduled instead of a full reconnect.
      pcs[0].channels[0].close()
      expect(rtc.getState()).toBe("open")
      expect(rtc.getCarrier()).toBe("relay")
      await new Promise((r) => setTimeout(r, 20))
      expect(pcs.length).toBeGreaterThan(1)
      rtc.close()
    })

    it("a Host that never acknowledges the relay behaves exactly as before", async () => {
      const { rtc, sig, pcs } = makeRtc()
      const connect = rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      expect(rtc.getState()).toBe("negotiating")
      sig.emitEnvelope(envelope("rtc:answer", { sdp: "v=0\r\nmock-answer" } as RtcAnswerBody, 2))
      await new Promise((r) => setTimeout(r, 5))
      pcs[0].channels[0].open()
      await connect
      expect(rtc.getCarrier()).toBe("datachannel")
      rtc.close()
    })

    it("with P2P off, never builds a peer connection and fails if the Host stays silent", async () => {
      const silent = makeRtc({ p2p: false, relayHandshakeTimeoutMs: 10 } as never)
      const failed = silent.rtc.connect()
      await new Promise((r) => setTimeout(r, 30))
      await expect(failed).rejects.toThrow(/relay data lane/)
      expect(silent.pcs).toHaveLength(0)

      const served = makeRtc({ p2p: false } as never)
      const connect = served.rtc.connect()
      await new Promise((r) => setTimeout(r, 5))
      served.sig.emitEnvelope(hostHello())
      await connect
      expect(served.rtc.getCarrier()).toBe("relay")
      expect(served.pcs).toHaveLength(0)
      served.rtc.close()
    })
  })
})
