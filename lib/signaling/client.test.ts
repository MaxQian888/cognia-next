/** @jest-environment jsdom */

import {
  buildRoomDescriptor,
  buildSubscribeProof,
  buildEnvelope,
  deriveDirectionKey,
  generateEcdhKeyPair,
  generateSigningKeyPair,
  importEcdhPublicKey,
  verifyAndDecryptEnvelope,
  type RoomDescriptor,
  type SubscribeProof,
  type SignalingKeyPair,
} from "./crypto"
import { SignalingClient } from "./client"
import type { ClientFrame, ServerFrame } from "./types"

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = FakeWebSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    instances.push(this)
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  push(frame: ServerFrame): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }))
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

interface Fixture {
  client: SignalingClient
  descriptor: RoomDescriptor
  mobileIdentity: SignalingKeyPair
  desktopIdentity: SignalingKeyPair
  desktopEcdh: SignalingKeyPair
}

const instances: FakeWebSocket[] = []
const clients: SignalingClient[] = []

beforeEach(() => {
  instances.length = 0
  clients.length = 0
  ;(globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket
})

afterEach(() => {
  for (const client of clients) client.close()
  jest.restoreAllMocks()
  jest.useRealTimers()
})

async function fixture(
  overrides: Partial<ConstructorParameters<typeof SignalingClient>[0]> = {}
): Promise<Fixture> {
  const [mobileIdentity, desktopIdentity, desktopEcdh] = await Promise.all([
    generateSigningKeyPair(),
    generateSigningKeyPair(),
    generateEcdhKeyPair(),
  ])
  const descriptor = await buildRoomDescriptor({
    roomNonce: "AAECAwQFBgcICQoLDA0ODw",
    desktopSigningKey: desktopIdentity.encodedPublicKey,
    mobileSigningKey: mobileIdentity.encodedPublicKey,
    notAfter: Date.now() + 60_000,
  })
  const client = new SignalingClient({
    url: "wss://signaling.test/signaling",
    descriptor,
    signingPrivateKey: mobileIdentity.privateKey,
    role: "mobile",
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    ...overrides,
  })
  clients.push(client)
  return { client, descriptor, mobileIdentity, desktopIdentity, desktopEcdh }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve()
}

async function waitForSent(socket: FakeWebSocket, kind: ClientFrame["kind"]): Promise<void> {
  for (let index = 0; index < 50; index++) {
    if (
      socket.sent.some((raw) => {
        return (JSON.parse(raw) as ClientFrame).kind === kind
      })
    ) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${kind}`)
}

async function waitForState(client: SignalingClient, expected: string): Promise<void> {
  for (let index = 0; index < 50; index++) {
    if (client.getState() === expected) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for state ${expected}; got ${client.getState()}`)
}

async function authenticateClient(
  value: Fixture,
  connect = true
): Promise<{
  socket: FakeWebSocket
  mobileProof: SubscribeProof
  desktopProof: SubscribeProof
}> {
  if (connect) value.client.connect()
  const socket = instances.at(-1)!
  socket.open()
  socket.push({
    kind: "challenge",
    challenge: "mobile-challenge",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 5_000,
  })
  await waitForSent(socket, "subscribe")
  const subscribe = socket.sent
    .map((raw) => JSON.parse(raw) as ClientFrame)
    .find((frame): frame is Extract<ClientFrame, { kind: "subscribe" }> => {
      return frame.kind === "subscribe"
    })
  expect(subscribe).toBeDefined()
  const mobileProof = subscribe!.proof
  const desktopProof = await buildSubscribeProof({
    roomId: value.descriptor.roomId,
    role: "desktop",
    sessionId: "desktop-session",
    epoch: "desktop-epoch",
    challenge: "desktop-challenge",
    ecdhPublicKey: value.desktopEcdh.encodedPublicKey,
    signingPrivateKey: value.desktopIdentity.privateKey,
  })
  socket.push({
    kind: "subscribed",
    rendezvousId: value.descriptor.roomId,
    peers: [{ proof: desktopProof, joinedAtMs: Date.now() }],
  })
  await waitForState(value.client, "subscribed")
  return { socket, mobileProof, desktopProof }
}

describe("SignalingClient", () => {
  it("waits for a challenge and sends a role-authenticated subscription", async () => {
    const value = await fixture()
    value.client.connect()
    const socket = instances[0]
    socket.open()
    expect(socket.sent).toHaveLength(0)

    socket.push({
      kind: "challenge",
      challenge: "server-challenge",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 5_000,
    })
    await waitForSent(socket, "subscribe")

    const frame = JSON.parse(socket.sent[0]) as ClientFrame
    expect(frame.kind).toBe("subscribe")
    if (frame.kind !== "subscribe") throw new Error("expected subscribe")
    expect(frame.descriptor).toEqual(value.descriptor)
    expect(frame.proof).toMatchObject({
      v: 2,
      roomId: value.descriptor.roomId,
      role: "mobile",
      challenge: "server-challenge",
    })
    expect(socket.url).toContain(`rid=${encodeURIComponent(value.descriptor.roomId)}`)
  })

  it("encrypts signaling payloads and serializes asynchronous sends by sequence", async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const started: number[] = []
    const value = await fixture({
      buildEnvelope: async (args) => {
        started.push(args.seq)
        if (args.seq === 1) await firstGate
        return buildEnvelope(args)
      },
    })
    const { socket, mobileProof } = await authenticateClient(value)

    const first = value.client.send("hello", { deviceId: "secret-device" })
    const second = value.client.send("rtc:offer", { sdp: "private-sdp" })
    await flush()
    expect(started).toEqual([1])
    releaseFirst()
    await Promise.all([first, second])

    const relays = socket.sent
      .map((raw) => JSON.parse(raw) as ClientFrame)
      .filter((frame): frame is Extract<ClientFrame, { kind: "relay" }> => frame.kind === "relay")
    expect(relays).toHaveLength(2)
    expect(relays.map((relay) => JSON.parse(relay.payload).seq)).toEqual([1, 2])
    expect(relays.map((relay) => relay.payload).join("")).not.toContain("private-sdp")

    const mobilePublic = await importEcdhPublicKey(mobileProof.ecdhPublicKey)
    const receiveKey = await deriveDirectionKey({
      privateKey: value.desktopEcdh.privateKey,
      peerPublicKey: mobilePublic,
      roomId: value.descriptor.roomId,
      senderRole: "mobile",
      epoch: mobileProof.epoch,
    })
    await expect(
      verifyAndDecryptEnvelope(JSON.parse(relays[1].payload), {
        expectedRoomId: value.descriptor.roomId,
        expectedSenderRole: "mobile",
        signingPublicKey: value.mobileIdentity.publicKey,
        encryptionKey: receiveKey,
      })
    ).resolves.toEqual({ kind: "rtc:offer", body: { sdp: "private-sdp" } })
  })

  it("bounds each signaling session to 64 active or queued sends", async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const value = await fixture({
      buildEnvelope: async (args) => {
        if (args.seq === 1) await firstGate
        return buildEnvelope(args)
      },
    })
    const { socket } = await authenticateClient(value)
    const errors: string[] = []
    value.client.on("error", ({ code }) => errors.push(code))

    const accepted = Array.from({ length: 64 }, (_, index) =>
      value.client.send("rtc:ice", { candidate: index }).catch((error: unknown) => error)
    )
    await expect(value.client.send("rtc:ice", { candidate: 65 })).rejects.toThrow(
      "outbound signaling queue is full"
    )

    expect(errors).toContain("outbound_queue_overflow")
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(value.client.getState()).toBe("reconnecting")

    releaseFirst()
    await Promise.all(accepted)
  })

  it("does not let a blocked old session delay a replacement session", async () => {
    jest.spyOn(Math, "random").mockReturnValue(0)
    let releaseOld!: () => void
    let blockNextEnvelope = true
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve
    })
    const value = await fixture({
      buildEnvelope: async (args) => {
        if (blockNextEnvelope) {
          blockNextEnvelope = false
          await oldGate
        }
        return buildEnvelope(args)
      },
    })
    const { socket: oldSocket } = await authenticateClient(value)
    const oldSend = value.client.send("rtc:offer", { sdp: "old" }).catch((error: unknown) => error)
    await flush()

    oldSocket.close()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const { socket: replacementSocket } = await authenticateClient(value, false)
    await value.client.send("rtc:offer", { sdp: "replacement" })

    expect(replacementSocket.sent.some((raw) => JSON.parse(raw).kind === "relay")).toBe(true)
    releaseOld()
    await oldSend
  })

  it("authenticates inbound session metadata and suppresses replays", async () => {
    const value = await fixture()
    const { socket, mobileProof, desktopProof } = await authenticateClient(value)
    const events: unknown[] = []
    const errors: string[] = []
    value.client.on("envelope", ({ envelope }) => events.push(envelope))
    value.client.on("error", ({ code }) => errors.push(code))

    const mobilePublic = await importEcdhPublicKey(mobileProof.ecdhPublicKey)
    const outboundKey = await deriveDirectionKey({
      privateKey: value.desktopEcdh.privateKey,
      peerPublicKey: mobilePublic,
      roomId: value.descriptor.roomId,
      senderRole: "desktop",
      epoch: desktopProof.epoch,
    })
    const envelope = await buildEnvelope({
      roomId: value.descriptor.roomId,
      senderRole: "desktop",
      sessionId: desktopProof.sessionId,
      epoch: desktopProof.epoch,
      seq: 1,
      kind: "rtc:answer",
      body: { sdp: "answer" },
      signingPrivateKey: value.desktopIdentity.privateKey,
      encryptionKey: outboundKey,
    })
    const relay: ServerFrame = {
      kind: "relay",
      rendezvousId: value.descriptor.roomId,
      fromRole: "desktop",
      fromSessionId: desktopProof.sessionId,
      payload: JSON.stringify(envelope),
    }
    socket.push(relay)
    for (let index = 0; index < 50 && events.length === 0 && errors.length === 0; index++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    socket.push(relay)
    for (let index = 0; index < 50 && !errors.includes("replayed"); index++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }

    expect({ events, errors }).toMatchObject({ events: expect.any(Array) })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ ver: 2, kind: "rtc:answer", body: { sdp: "answer" } })
    expect(errors).toContain("replayed")
  })

  it("enters awaiting-peer and only honors peer-left for the active session", async () => {
    const value = await fixture()
    value.client.connect()
    const socket = instances[0]
    socket.open()
    socket.push({
      kind: "challenge",
      challenge: "challenge",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 5_000,
    })
    await flush()
    socket.push({
      kind: "subscribed",
      rendezvousId: value.descriptor.roomId,
      peers: [],
    })
    await waitForState(value.client, "awaiting-peer")
    expect(value.client.getState()).toBe("awaiting-peer")

    socket.push({
      kind: "peerLeft",
      rendezvousId: value.descriptor.roomId,
      role: "desktop",
      sessionId: "stale-session",
    })
    expect(value.client.getState()).toBe("awaiting-peer")
  })

  it("treats authenticated session replacement as terminal", async () => {
    const value = await fixture()
    value.client.connect()
    const socket = instances[0]
    socket.open()
    socket.push({
      kind: "error",
      code: "session_replaced",
      message: "new session",
    })
    await waitForState(value.client, "rejected")
    expect(value.client.getState()).toBe("rejected")
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  })
})
