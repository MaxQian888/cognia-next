/**
 * SignalingClient unit tests — pure-JS WebSocket mock, no network. Verifies
 * the full subscribe → relay → reconnect lifecycle plus HMAC + replay
 * rejection paths.
 */

import { buildSignedEnvelope } from "./envelope"
import { SignalingClient } from "./client"
import type { ClientFrame, ServerFrame } from "./types"

/**
 * Drain pending microtasks (Promise resolutions + queued .then callbacks).
 * `handleRaw → handleRelay → verifySignedEnvelope` chains five awaits, so
 * two `Promise.resolve()`s isn't enough — a real macrotask boundary lets
 * everything settle.
 */
function flushAsync(): Promise<void> {
  // Web Crypto's `subtle.sign` is dispatched to libuv's worker pool in Node,
  // so a single microtask flush isn't enough. 30ms reliably waits past both
  // worker-pool turnaround and any subsequent microtask cascade.
  return new Promise<void>((resolve) => setTimeout(resolve, 30))
}

// ---------------------------------------------------------------------------
// In-memory WebSocket double
// ---------------------------------------------------------------------------

class FakeWebSocket {
  static OPEN = 1
  static CLOSED = 3

  readyState: number = 0
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null

  readonly sent: string[] = []

  constructor(public url: string) {
    instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  // Test helpers
  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.(new Event("open"))
  }
  push(frame: ServerFrame): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }
  pushRaw(text: string): void {
    this.onmessage?.({ data: text } as MessageEvent)
  }
  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.(new CloseEvent("close"))
  }
}

const SECRET = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
const instances: FakeWebSocket[] = []

beforeEach(() => {
  instances.length = 0
  ;(globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket
})

afterEach(() => {
  jest.useRealTimers()
})

function makeClient(): SignalingClient {
  return new SignalingClient({
    url: "wss://signaling.test/v1/signaling",
    rendezvousId: "room-1",
    rendezvousSecret: SECRET,
    role: "mobile",
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  })
}

function parseSent(ws: FakeWebSocket, idx: number): ClientFrame {
  return JSON.parse(ws.sent[idx]) as ClientFrame
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe("SignalingClient", () => {
  it("sends subscribe on open and transitions to subscribed on ack", async () => {
    const client = makeClient()
    const events: string[] = []
    client.on("state", (s) => events.push(s))
    client.connect()

    expect(events).toEqual(["connecting"])
    const ws = instances[0]
    ws.open()
    expect(parseSent(ws, 0)).toMatchObject({
      kind: "subscribe",
      rendezvousId: "room-1",
      role: "mobile",
    })

    ws.push({ kind: "subscribed", rendezvousId: "room-1", peers: [] })
    expect(client.getState()).toBe("subscribed")
    expect(events).toEqual(["connecting", "subscribed"])
  })

  it("enters rejected and stops reconnecting on a terminal room_full error", async () => {
    const client = makeClient()
    const states: string[] = []
    const errors: { code: string; message: string }[] = []
    client.on("state", (s) => states.push(s))
    client.on("error", (e) => errors.push(e))
    client.connect()
    const ws = instances[0]
    ws.open()

    ws.push({ kind: "error", code: "room_full", message: "rendezvous room is full" })

    expect(errors).toEqual([{ code: "room_full", message: "rendezvous room is full" }])
    expect(client.getState()).toBe("rejected")
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED)

    // No auto-reconnect: even after timers fire, no new socket is created.
    await flushAsync()
    expect(instances).toHaveLength(1)
    expect(states).toEqual(["connecting", "rejected"])
  })

  it("treats role_taken as terminal too", () => {
    const client = makeClient()
    client.connect()
    instances[0].open()
    instances[0].push({
      kind: "error",
      code: "role_taken",
      message: "a desktop peer already owns this room",
    })
    expect(client.getState()).toBe("rejected")
  })

  it("does not reject on a non-terminal error and keeps the socket open", () => {
    const client = makeClient()
    client.connect()
    const ws = instances[0]
    ws.open()
    ws.push({ kind: "subscribed", rendezvousId: "room-1", peers: [] })
    ws.push({ kind: "error", code: "rate_limited", message: "too many frames" })
    expect(client.getState()).toBe("subscribed")
    expect(ws.readyState).toBe(FakeWebSocket.OPEN)
  })

  it("appends the rendezvous id as a rid query param on connect", () => {
    const client = makeClient()
    client.connect()
    expect(instances[0].url).toBe("wss://signaling.test/v1/signaling?rid=room-1")
  })

  it("uses & when the signaling url already has a query string", () => {
    const client = new SignalingClient({
      url: "wss://signaling.test/v1/signaling?region=eu",
      rendezvousId: "room-1",
      rendezvousSecret: SECRET,
      role: "mobile",
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    })
    client.connect()
    expect(instances[0].url).toBe("wss://signaling.test/v1/signaling?region=eu&rid=room-1")
  })

  it("emits peerJoined and peerLeft", () => {
    const client = makeClient()
    const joined: string[] = []
    const left: string[] = []
    client.on("peerJoined", (r) => joined.push(r))
    client.on("peerLeft", (r) => left.push(r))
    client.connect()
    const ws = instances[0]
    ws.open()
    ws.push({ kind: "peerJoined", rendezvousId: "room-1", role: "desktop" })
    ws.push({ kind: "peerLeft", rendezvousId: "room-1", role: "desktop" })
    expect(joined).toEqual(["desktop"])
    expect(left).toEqual(["desktop"])
  })

  it("verifies and forwards relay envelopes from the peer", async () => {
    const client = makeClient()
    const received: Array<{ role: string; kind: string }> = []
    client.on("envelope", ({ fromRole, envelope }) => {
      received.push({ role: fromRole, kind: envelope.kind })
    })
    client.connect()
    const ws = instances[0]
    ws.open()

    const env = await buildSignedEnvelope({
      seq: 1,
      kind: "hello",
      body: { deviceId: "desk-1" },
      rendezvousSecret: SECRET,
    })
    const payload = btoa(JSON.stringify(env))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")
    ws.push({
      kind: "relay",
      rendezvousId: "room-1",
      fromRole: "desktop",
      payload,
    })

    await flushAsync()
    expect(received).toEqual([{ role: "desktop", kind: "hello" }])
  })

  it("rejects relay envelopes with bad HMAC", async () => {
    const client = makeClient()
    const errs: string[] = []
    client.on("error", ({ code }) => errs.push(code))
    client.connect()
    const ws = instances[0]
    ws.open()

    const env = await buildSignedEnvelope({
      seq: 1,
      kind: "hello",
      body: { deviceId: "desk-1" },
      rendezvousSecret: SECRET,
    })
    const tampered = { ...env, body: { deviceId: "attacker" } }
    const payload = btoa(JSON.stringify(tampered))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")
    ws.push({
      kind: "relay",
      rendezvousId: "room-1",
      fromRole: "desktop",
      payload,
    })

    await flushAsync()
    expect(errs).toContain("relay_mac_mismatch")
  })

  it("rejects replayed envelopes", async () => {
    const client = makeClient()
    const errs: string[] = []
    client.on("error", ({ code }) => errs.push(code))
    client.connect()
    const ws = instances[0]
    ws.open()

    const env = await buildSignedEnvelope({
      seq: 7,
      kind: "rtc:ice",
      body: { candidate: {} },
      rendezvousSecret: SECRET,
    })
    const payload = btoa(JSON.stringify(env))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "")
    ws.push({
      kind: "relay",
      rendezvousId: "room-1",
      fromRole: "desktop",
      payload,
    })
    ws.push({
      kind: "relay",
      rendezvousId: "room-1",
      fromRole: "desktop",
      payload,
    })

    await flushAsync()
    expect(errs).toContain("replayed")
  })

  it("send() signs with the configured secret and increments seq", async () => {
    const client = makeClient()
    client.connect()
    const ws = instances[0]
    ws.open()
    ws.push({ kind: "subscribed", rendezvousId: "room-1", peers: [] })

    await client.send("hello", { deviceId: "mob-1" })
    await client.send("rtc:offer", { sdp: "x" })

    // Sent frames: [0] subscribe, [1] hello relay, [2] offer relay.
    const helloFrame = parseSent(ws, 1)
    const offerFrame = parseSent(ws, 2)
    expect(helloFrame.kind).toBe("relay")
    expect(offerFrame.kind).toBe("relay")

    const decode = (frame: ClientFrame) => {
      if (frame.kind !== "relay") throw new Error("not a relay")
      const padded = frame.payload + "=".repeat((4 - (frame.payload.length % 4)) % 4)
      const json = atob(padded.replace(/-/g, "+").replace(/_/g, "/"))
      return JSON.parse(json)
    }
    const helloEnv = decode(helloFrame)
    const offerEnv = decode(offerFrame)
    expect(helloEnv.seq).toBe(1)
    expect(offerEnv.seq).toBe(2)
    expect(helloEnv.kind).toBe("hello")
    expect(offerEnv.kind).toBe("rtc:offer")
  })

  it("schedules reconnect after disconnect", async () => {
    jest.useFakeTimers()
    const client = makeClient()
    client.connect()
    const ws = instances[0]
    ws.open()
    ws.push({ kind: "subscribed", rendezvousId: "room-1", peers: [] })

    ws.close()
    expect(client.getState()).toBe("reconnecting")
    jest.runAllTimers()
    expect(instances.length).toBe(2)
  })

  it("close() stops further reconnect attempts", async () => {
    jest.useFakeTimers()
    const client = makeClient()
    client.connect()
    const ws = instances[0]
    ws.open()
    ws.close()
    expect(client.getState()).toBe("reconnecting")
    client.close()
    jest.runAllTimers()
    expect(instances.length).toBe(1)
    expect(client.getState()).toBe("closed")
  })

  it("send() throws when the socket is not open", async () => {
    const client = makeClient()
    await expect(client.send("hello", {})).rejects.toThrow(/not connected/)
  })

  it("ignores duplicate connect() calls", () => {
    const client = makeClient()
    client.connect()
    client.connect()
    expect(instances.length).toBe(1)
  })
})
