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
  bufferedAmount = 0
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
  useFakeSendClock: () => void
  descriptor: RoomDescriptor
  mobileIdentity: SignalingKeyPair
  desktopIdentity: SignalingKeyPair
  desktopEcdh: SignalingKeyPair
}

const realSetTimeout = globalThis.setTimeout.bind(globalThis)
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
  const clearRealTimer = globalThis.clearTimeout.bind(globalThis)
  const scheduler = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: clearRealTimer,
  }
  const useFakeSendClock = () => {
    jest.useFakeTimers()
    scheduler.setTimeout = globalThis.setTimeout.bind(globalThis)
    scheduler.clearTimeout = (timer) => {
      clearRealTimer(timer)
      globalThis.clearTimeout(timer)
    }
  }
  const client = new SignalingClient({
    url: "wss://signaling.test/signaling",
    descriptor,
    signingPrivateKey: mobileIdentity.privateKey,
    role: "mobile",
    scheduler,
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    ...overrides,
  })
  clients.push(client)
  return { client, descriptor, mobileIdentity, desktopIdentity, desktopEcdh, useFakeSendClock }
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
    await new Promise((resolve) => realSetTimeout(resolve, 0))
  }
  throw new Error(`timed out waiting for ${kind}`)
}

async function waitForState(client: SignalingClient, expected: string): Promise<void> {
  for (let index = 0; index < 50; index++) {
    if (client.getState() === expected) return
    await new Promise((resolve) => realSetTimeout(resolve, 0))
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
    await new Promise((resolve) => realSetTimeout(resolve, 0))
    const { socket: replacementSocket } = await authenticateClient(value, false)
    await value.client.send("rtc:offer", { sdp: "replacement" })

    expect(replacementSocket.sent.some((raw) => JSON.parse(raw).kind === "relay")).toBe(true)
    releaseOld()
    await oldSend
  })

  it("paces a 512-frame data burst and lets signaling pass while data waits", async () => {
    const value = await fixture({
      buildEnvelope: async (args) =>
        ({ seq: args.seq, kind: args.kind }) as Awaited<ReturnType<typeof buildEnvelope>>,
    })
    const { socket } = await authenticateClient(value)
    value.useFakeSendClock()
    const sends = Array.from({ length: 512 }, (_, index) => value.client.send("data", { index }))
    await jest.advanceTimersByTimeAsync(0)
    const relays = () =>
      socket.sent.map((raw) => JSON.parse(raw)).filter((frame) => frame.kind === "relay")
    expect(relays()).toHaveLength(256)
    await value.client.send("rtc:ice", { candidate: "still-responsive" })
    expect(JSON.parse(relays().at(-1).payload).kind).toBe("rtc:ice")
    await jest.advanceTimersByTimeAsync(4_000)
    await Promise.all(sends)
    expect(relays()).toHaveLength(513)
    expect(relays().map((frame) => JSON.parse(frame.payload).seq)).toEqual(
      Array.from({ length: 513 }, (_, index) => index + 1)
    )
  })

  it("waits for WebSocket capacity and cancels queued sends when closed", async () => {
    const value = await fixture({
      buildEnvelope: async (args) =>
        ({ seq: args.seq, kind: args.kind }) as Awaited<ReturnType<typeof buildEnvelope>>,
    })
    const { socket } = await authenticateClient(value)
    value.useFakeSendClock()
    socket.bufferedAmount = 2 * 1024 * 1024
    const pending = value.client.send("data", { bytes: "queued" }).catch((error: unknown) => error)
    await jest.advanceTimersByTimeAsync(100)
    expect(socket.sent.filter((raw) => JSON.parse(raw).kind === "relay")).toHaveLength(0)
    socket.bufferedAmount = 0
    await jest.advanceTimersByTimeAsync(25)
    await expect(pending).resolves.toBeUndefined()
    socket.bufferedAmount = 2 * 1024 * 1024
    const cancelled = value.client.send("data", {}).catch((error: unknown) => error)
    value.client.close()
    await expect(cancelled).resolves.toBeInstanceOf(Error)
    expect(jest.getTimerCount()).toBe(0)
  })

  it("keeps signaling capacity separate from queued data and fails a stuck socket boundedly", async () => {
    const value = await fixture({
      buildEnvelope: async (args) =>
        ({ seq: args.seq, kind: args.kind }) as Awaited<ReturnType<typeof buildEnvelope>>,
    })
    const { socket } = await authenticateClient(value)
    value.useFakeSendClock()
    socket.bufferedAmount = 2 * 1024 * 1024
    const pending = Array.from({ length: 65 }, () =>
      value.client.send("data", {}).catch((error: unknown) => error)
    )
    const signal = value.client.send("rtc:ice", {}).catch((error: unknown) => error)
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    const errors: string[] = []
    value.client.on("error", ({ code }) => errors.push(code))
    await jest.advanceTimersByTimeAsync(15_025)
    expect(errors).toContain("outbound_backpressure_timeout")
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    expect(await signal).toBeInstanceOf(Error)
    expect((await Promise.all(pending)).every((error) => error instanceof Error)).toBe(true)
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
      await new Promise((resolve) => realSetTimeout(resolve, 0))
    }
    socket.push(relay)
    for (let index = 0; index < 50 && !errors.includes("replayed"); index++) {
      await new Promise((resolve) => realSetTimeout(resolve, 0))
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

  it("rejects malformed and unauthenticated relay traffic without losing the session", async () => {
    const value = await fixture()
    const { socket, mobileProof, desktopProof } = await authenticateClient(value)
    const errors: string[] = []
    value.client.on("error", ({ code }) => errors.push(code))
    socket.onmessage?.(new MessageEvent("message", { data: "{" }))
    socket.onmessage?.(new MessageEvent("message", { data: "null" }))
    const relay = {
      kind: "relay" as const,
      rendezvousId: value.descriptor.roomId,
      fromRole: "desktop" as const,
      fromSessionId: desktopProof.sessionId,
      payload: "{",
    }
    socket.push({ ...relay, fromSessionId: "wrong-session" })
    socket.push(relay)
    socket.push({
      ...relay,
      payload: JSON.stringify({ sessionId: desktopProof.sessionId, epoch: "wrong" }),
    })
    socket.push({
      ...relay,
      payload: JSON.stringify({
        sessionId: desktopProof.sessionId,
        epoch: desktopProof.epoch,
        seq: 2,
      }),
    })
    socket.push({
      kind: "peerJoined",
      rendezvousId: value.descriptor.roomId,
      peer: { proof: mobileProof, joinedAtMs: Date.now() },
    })
    socket.push({
      kind: "peerJoined",
      rendezvousId: value.descriptor.roomId,
      peer: { proof: { ...desktopProof, signature: "bad" }, joinedAtMs: Date.now() },
    })
    socket.push({ kind: "error", code: "rate_limited", message: "slow down" })
    for (let index = 0; index < 100 && !errors.includes("rate_limited"); index++) {
      await new Promise((resolve) => realSetTimeout(resolve, 0))
    }
    expect(errors).toEqual(
      expect.arrayContaining([
        "malformed_frame",
        "frame_processing",
        "relay_session",
        "relay_parse",
        "relay_auth_failed",
        "peer_role",
        "peer_auth_failed",
        "rate_limited",
      ])
    )
    expect(value.client.getState()).toBe("subscribed")
  })

  it.each([new Error("key generation failed"), "crypto unavailable"])(
    "recovers when subscribe cryptography fails: %s",
    async (failure) => {
      const value = await fixture({
        generateEcdhKeyPair: async () => {
          throw failure
        },
      })
      await expect(value.client.send("hello", {})).rejects.toThrow("not connected")
      value.client.connect()
      const socket = instances.at(-1)!
      socket.open()
      socket.push({
        kind: "challenge",
        challenge: "fresh",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 5000,
      })
      await waitForState(value.client, "reconnecting")
      expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
    }
  )

  it("refuses unsupported versions and expired challenges", async () => {
    const value = await fixture()
    expect(
      () =>
        new SignalingClient({
          url: "wss://unused",
          descriptor: { ...value.descriptor, v: 1 } as unknown as RoomDescriptor,
          signingPrivateKey: value.mobileIdentity.privateKey,
          role: "mobile",
        })
    ).toThrow("unsupported signaling protocol")
    value.client.connect()
    value.client.connect()
    expect(instances).toHaveLength(1)
    const socket = instances.at(-1)!
    socket.open()
    socket.push({ kind: "challenge", challenge: "expired", issuedAt: 0, expiresAt: 0 })
    await waitForState(value.client, "reconnecting")
    value.client.close()
    value.client.connect()
    expect(value.client.getState()).toBe("closed")
  })

  it("keeps a full data queue local and reports socket send failures", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const value = await fixture({
      buildEnvelope: async (args) => {
        await gate
        return { seq: args.seq, kind: args.kind } as Awaited<ReturnType<typeof buildEnvelope>>
      },
    })
    const { socket } = await authenticateClient(value)
    const sends = Array.from({ length: 1024 }, () =>
      value.client.send("data", {}).catch((error: unknown) => error)
    )
    await expect(value.client.send("data", {})).rejects.toMatchObject({
      code: "signaling_queue_full",
    })
    expect(socket.readyState).toBe(FakeWebSocket.OPEN)
    value.client.close()
    release()
    expect((await Promise.all(sends)).every((error) => error instanceof Error)).toBe(true)
    const replacement = await fixture({
      buildEnvelope: async (args) =>
        ({ seq: args.seq, kind: args.kind }) as Awaited<ReturnType<typeof buildEnvelope>>,
    })
    const { socket: next } = await authenticateClient(replacement)
    jest.spyOn(next, "send").mockImplementationOnce(() => {
      throw "socket failed"
    })
    await expect(replacement.client.send("hello", {})).rejects.toThrow("socket failed")
    jest.spyOn(next, "close").mockImplementationOnce(() => {
      throw new Error("already closed")
    })
    expect(() => replacement.client.close()).not.toThrow()
  })

  it("maintains heartbeat liveness during healthy sessions and detects a missed pong", async () => {
    const value = await fixture()
    const { socket } = await authenticateClient(value)
    value.useFakeSendClock()
    // Refresh timers through the public subscribed frame using the fake clock.
    socket.push({ kind: "subscribed", rendezvousId: value.descriptor.roomId, peers: [] })
    await flush()
    const observed: string[] = []
    value.client.on("error", () => {
      throw new Error("listener failure")
    })
    value.client.on("error", ({ code }) => observed.push(code))
    for (let i = 0; i < 3; i++) {
      await jest.advanceTimersByTimeAsync(20_000)
      socket.push({ kind: "pong" })
      await flush()
    }
    expect(value.client.getState()).toBe("subscribed")
    expect(socket.sent.filter((raw) => JSON.parse(raw).kind === "ping")).toHaveLength(3)
    await jest.advanceTimersByTimeAsync(30_000)
    expect(observed).toContain("pong_timeout")
    expect(socket.readyState).toBe(FakeWebSocket.CLOSED)
  })

  it("rejects queued sends when the authenticated peer leaves during encryption", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const value = await fixture({
      buildEnvelope: async (args) => {
        await gate
        return { seq: args.seq, kind: args.kind } as Awaited<ReturnType<typeof buildEnvelope>>
      },
    })
    const { socket, desktopProof } = await authenticateClient(value)
    const first = value.client.send("data", {}).catch((error: unknown) => error)
    const queued = value.client.send("data", {}).catch((error: unknown) => error)
    const left: string[] = []
    const detach = value.client.on("peerLeft", (role) => left.push(role))
    socket.push({
      kind: "peerLeft",
      rendezvousId: value.descriptor.roomId,
      role: "desktop",
      sessionId: desktopProof.sessionId,
    })
    await flush()
    expect(value.client.getState()).toBe("awaiting-peer")
    expect(left).toEqual(["desktop"])
    detach()
    await expect(value.client.send("data", {})).rejects.toThrow("not connected")
    release()
    expect(await first).toBeInstanceOf(Error)
    expect(await queued).toBeInstanceOf(Error)
    expect(socket.sent.filter((raw) => JSON.parse(raw).kind === "relay")).toHaveLength(0)
  })

  it("uses the default socket factory and recovers even when close throws", async () => {
    const value = await fixture()
    const client = new SignalingClient({
      url: "wss://signaling.test/signaling?existing=1",
      descriptor: value.descriptor,
      signingPrivateKey: value.mobileIdentity.privateKey,
      role: "mobile",
    })
    clients.push(client)
    client.connect()
    const socket = instances.at(-1)!
    expect(socket.url).toContain("?existing=1&rid=")
    socket.open()
    socket.onerror?.()
    jest.spyOn(socket, "close").mockImplementationOnce(() => {
      throw new Error("close failed")
    })
    socket.push({ kind: "challenge", challenge: "expired", issuedAt: 0, expiresAt: 0 })
    await waitForState(client, "reconnecting")
    const staleOpen = socket.onopen
    const staleMessage = socket.onmessage
    const staleClose = socket.onclose
    client.close()
    staleOpen?.()
    staleMessage?.(new MessageEvent("message", { data: "{}" }))
    staleClose?.()
    expect(client.getState()).toBe("closed")
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
