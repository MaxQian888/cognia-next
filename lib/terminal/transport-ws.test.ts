/** @jest-environment jsdom */

let mockIsCapacitor = true
let mockHasWebCompanionTarget = false
const mockCompanionStorageLoad = jest.fn(async () => COMPANION_ENDPOINT_FROM_STORAGE)

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  isCapacitor: () => mockIsCapacitor,
}))

jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => mockHasWebCompanionTarget,
}))

jest.mock("@/lib/tauri/companion-storage", () => ({
  pickCompanionStorage: () => ({ load: mockCompanionStorageLoad }),
}))

import { setActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"

import {
  decodeTerminalFrame,
  decodeTerminalJson,
  encodeTerminalFrame,
  makeTerminalFrame,
  TerminalFrameKind,
} from "./protocol"
import {
  __resetEndpointResolverForTesting,
  __setSocketTicketIssuerForTesting,
  __setTerminalDataChannelResolverForTesting,
  __setWebSocketFactoryForTesting,
  configureCompanionEndpointResolver,
  pickRemoteSpawn,
  RemoteTerminalSession,
} from "./transport-ws"

const COMPANION_ENDPOINT = {
  baseUrl: "https://desktop.local:27890",
  deviceId: "device-1",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-key" },
  deviceKeyThumbprint: "thumbprint",
  serverVersion: "1.0.0",
}

/** What the shell-agnostic companion target book hands back. */
const COMPANION_ENDPOINT_FROM_STORAGE = {
  ...COMPANION_ENDPOINT,
  baseUrl: "https://cognia.example:27890",
  deviceId: "browser-device-1",
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111"

interface MockSocket {
  url: string
  readyState: number
  binaryType: string
  sent: Uint8Array[]
  send: jest.Mock
  close: jest.Mock
  addEventListener: jest.Mock
  removeEventListener: jest.Mock
  fireOpen(): void
  fireFrame(kind: TerminalFrameKind, payload?: unknown, sequence?: bigint): void
  fireBytes(kind: TerminalFrameKind, payload: Uint8Array, sequence?: bigint): void
  fireClose(): void
  fireError(): void
}

const sockets: MockSocket[] = []
let ticketCounter = 0

class MockTerminalDataChannel extends EventTarget {
  readonly label = "cognia.terminal"
  readonly ordered = true
  readyState: RTCDataChannelState = "connecting"
  binaryType: BinaryType = "blob"
  sent: Uint8Array[] = []

  send(value: ArrayBuffer | ArrayBufferView): void {
    const bytes =
      value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    this.sent.push(new Uint8Array(bytes))
  }

  open(): void {
    this.readyState = "open"
    this.dispatchEvent(new Event("open"))
  }

  fireFrame(kind: TerminalFrameKind, payload: unknown, sequence: bigint): void {
    const bytes = encodeTerminalFrame(
      makeTerminalFrame(kind, {
        sessionId: SESSION_ID,
        sequence,
        payload: new TextEncoder().encode(JSON.stringify(payload)),
      })
    )
    this.dispatchEvent(new MessageEvent("message", { data: bytes.slice().buffer }))
  }

  close(): void {
    this.readyState = "closed"
    this.dispatchEvent(new Event("close"))
  }
}

function latestSocket(): MockSocket {
  const socket = sockets.at(-1)
  if (!socket) throw new Error("no WebSocket created")
  return socket
}

function sessionInfo() {
  return {
    id: SESSION_ID,
    hostId: "host-a",
    kind: "localPty" as const,
    profileId: "profile-a",
    projectId: "project-a",
    extensionId: null,
    origin: "remote" as const,
    shell: "/bin/zsh",
    createdAt: 1,
    lastActivityAt: 2,
    currentController: "companion:device-a",
    attachedClients: 1,
    alive: true,
    sandboxed: true,
    integrationCapabilities: {
      osc633: true,
      commandStatus: true,
      cwdTracking: true,
      degradedReason: null,
    },
    replay: { firstSequence: 0, lastSequence: 0, retainedBytes: 0, truncated: false },
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function completeSpawn(
  request: Parameters<typeof RemoteTerminalSession.spawn>[0] = {
    profileId: "profile-a",
    shell: "/bin/zsh",
    rows: 24,
    cols: 80,
  }
): Promise<RemoteTerminalSession> {
  const promise = RemoteTerminalSession.spawn(request)
  await flush()
  const socket = latestSocket()
  socket.fireOpen()
  await flush()
  const spawn = decodeTerminalFrame(socket.sent.at(-1)!)
  socket.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), spawn.sequence)
  return promise
}

beforeAll(() => {
  ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = class {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSED = 3
    url: string
    readyState = 0
    binaryType = "blob"
    sent: Uint8Array[] = []
    private listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>()

    constructor(url: string) {
      this.url = url
      sockets.push(this as unknown as MockSocket)
    }

    send = jest.fn((value: Uint8Array) => this.sent.push(new Uint8Array(value)))
    close = jest.fn(() => {
      this.readyState = 3
    })
    addEventListener = jest.fn(
      (
        name: string,
        listener: (event: Event | MessageEvent) => void,
        options?: AddEventListenerOptions
      ) => {
        const wrapped = options?.once
          ? (event: Event | MessageEvent) => {
              this.listeners.get(name)?.delete(wrapped)
              listener(event)
            }
          : listener
        const listeners = this.listeners.get(name) ?? new Set()
        listeners.add(wrapped)
        this.listeners.set(name, listeners)
      }
    )
    removeEventListener = jest.fn((name: string, listener: (event: Event) => void) => {
      this.listeners.get(name)?.delete(listener)
    })
    private fire(name: string, event: Event | MessageEvent): void {
      for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event)
    }
    fireOpen(): void {
      this.readyState = 1
      this.fire("open", new Event("open"))
    }
    fireFrame(kind: TerminalFrameKind, payload: unknown = {}, sequence = BigInt(0)): void {
      const bytes = new TextEncoder().encode(JSON.stringify(payload))
      this.fireBytes(kind, bytes, sequence)
    }
    fireBytes(kind: TerminalFrameKind, payload: Uint8Array, sequence = BigInt(0)): void {
      const encoded = encodeTerminalFrame(
        makeTerminalFrame(kind, { sessionId: SESSION_ID, sequence, payload })
      )
      this.fire("message", new MessageEvent("message", { data: encoded.slice().buffer }))
    }
    fireClose(): void {
      this.readyState = 3
      this.fire("close", new Event("close"))
    }
    fireError(): void {
      this.fire("error", new Event("error"))
    }
  }
})

beforeEach(() => {
  sockets.splice(0)
  ticketCounter = 0
  mockIsCapacitor = true
  mockHasWebCompanionTarget = false
  mockCompanionStorageLoad.mockClear()
  configureCompanionEndpointResolver(async () => ({
    ...COMPANION_ENDPOINT,
  }))
  __setSocketTicketIssuerForTesting(async () => ({
    ticket: `ticket-${++ticketCounter}`,
    expiresAt: Date.now() + 60_000,
  }))
  __setWebSocketFactoryForTesting()
  __setTerminalDataChannelResolverForTesting()
})

afterEach(() => {
  jest.useRealTimers()
  __resetEndpointResolverForTesting()
})

describe("RemoteTerminalSession canonical LAN transport", () => {
  it("lists and reattaches existing host-owned sessions", async () => {
    const listPromise = RemoteTerminalSession.listLan()
    await flush()
    latestSocket().fireOpen()
    await flush()
    const list = decodeTerminalFrame(latestSocket().sent[0])
    expect(list.kind).toBe(TerminalFrameKind.List)
    latestSocket().fireFrame(
      TerminalFrameKind.HostSnapshot,
      { hostId: "host-a", sessions: [sessionInfo()] },
      list.sequence
    )
    await expect(listPromise).resolves.toEqual([sessionInfo()])

    const attachPromise = RemoteTerminalSession.reattachLan(SESSION_ID, 9)
    await flush()
    latestSocket().fireOpen()
    await flush()
    const attach = decodeTerminalFrame(latestSocket().sent[0])
    expect(attach.kind).toBe(TerminalFrameKind.Attach)
    expect(decodeTerminalJson(attach)).toEqual({ resumeAfter: 9 })
    latestSocket().fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), attach.sequence)
    await expect(attachPromise).resolves.toMatchObject({ info: { id: SESSION_ID } })
  })

  it("uses a single-use ticket URL and sends only a synchronized profile identifier", async () => {
    const promise = RemoteTerminalSession.spawn({
      profileId: "profile-a",
      shell: "/bin/zsh",
      cwd: "/secret/project",
      env: { SECRET: "must-not-cross-the-wire" },
      rows: 24,
      cols: 80,
    })
    await flush()
    const socket = latestSocket()
    expect(socket.url).toContain("/ws/terminal?ticket=ticket-1")
    expect(socket.url).not.toContain("device-jwt")
    expect(socket.url).not.toContain("shell")
    socket.fireOpen()
    await flush()
    const frame = decodeTerminalFrame(socket.sent[0]!)
    expect(frame.kind).toBe(TerminalFrameKind.Spawn)
    expect(decodeTerminalJson(frame)).toEqual({ profileId: "profile-a" })
    socket.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), frame.sequence)
    await expect(promise).resolves.toMatchObject({ id: SESSION_ID })
  })

  it("surfaces typed spawn errors", async () => {
    const promise = RemoteTerminalSession.spawn({ shell: "ignored", rows: 24, cols: 80 })
    await flush()
    latestSocket().fireOpen()
    await flush()
    const request = decodeTerminalFrame(latestSocket().sent[0]!)
    latestSocket().fireFrame(
      TerminalFrameKind.Error,
      { code: "resource_limit", message: "host session limit" },
      request.sequence
    )
    await expect(promise).rejects.toMatchObject({ code: "resource_limit" })
  })

  it("dispatches output, integration, replay gaps, controller changes, and exit", async () => {
    const session = await completeSpawn()
    const output: number[][] = []
    const integrations: unknown[] = []
    const gaps: unknown[] = []
    const controls: unknown[] = []
    let exit: number | null | undefined
    session.onData((bytes) => output.push([...bytes]))
    session.onIntegration((event) => integrations.push(event))
    session.onReplayGap((gap) => gaps.push(gap))
    session.onControlState((state) => controls.push(state))
    session.onExit((code) => {
      exit = code
    })
    latestSocket().fireBytes(TerminalFrameKind.Stdout, new Uint8Array([72, 105]), BigInt(4))
    latestSocket().fireFrame(TerminalFrameKind.Integration, { kind: "prompt_start" }, BigInt(5))
    latestSocket().fireFrame(TerminalFrameKind.ReplayGap, {
      requestedAfter: 1,
      firstAvailable: 3,
      lastAvailable: 5,
    })
    latestSocket().fireFrame(TerminalFrameKind.ControllerChanged, {
      controller: "another-device",
    })
    latestSocket().fireFrame(TerminalFrameKind.Exit, { code: 7 }, BigInt(6))
    await flush()
    expect(output).toEqual([[72, 105]])
    expect(integrations).toEqual([{ kind: "prompt_start" }])
    expect(gaps).toEqual([{ requestedAfter: 1, firstAvailable: 3, lastAvailable: 5 }])
    expect(controls).toContainEqual({
      role: "viewer",
      controllerId: "another-device",
      reason: "takeover",
    })
    expect(exit).toBe(7)
  })

  it("applies unsolicited (sequence 0) session snapshots as roster refreshes (ADR-0131)", async () => {
    const session = await completeSpawn()
    const before = session.info
    const infos: number[] = []
    session.onInfo((info) => infos.push(info.participants?.length ?? -1))

    latestSocket().fireFrame(
      TerminalFrameKind.SessionSnapshot,
      {
        ...sessionInfo(),
        currentController: "desktop",
        attachedClients: 2,
        participants: [
          { clientId: "desktop", deviceId: null, local: true, role: "controller" },
          { clientId: "companion:device-a", deviceId: "device-a", local: false, role: "viewer" },
        ],
      },
      BigInt(0)
    )
    await flush()

    expect(session.info).toBe(before)
    expect(session.info.currentController).toBe("desktop")
    expect(session.participants).toHaveLength(2)
    expect(infos).toEqual([2])
  })

  it("encodes stdin, resize, control, detach, and kill as binary commands", async () => {
    const session = await completeSpawn()
    await session.write("ls\n")
    const stdin = decodeTerminalFrame(latestSocket().sent.at(-1)!)
    expect(stdin.kind).toBe(TerminalFrameKind.Stdin)
    expect([...stdin.payload]).toEqual([108, 115, 10])

    const resize = session.resize(32, 120)
    await flush()
    let request = decodeTerminalFrame(latestSocket().sent.at(-1)!)
    expect(request.kind).toBe(TerminalFrameKind.Resize)
    latestSocket().fireFrame(TerminalFrameKind.Ack, { ok: true }, request.sequence)
    await resize

    const take = session.takeControl()
    await flush()
    request = decodeTerminalFrame(latestSocket().sent.at(-1)!)
    expect(request.kind).toBe(TerminalFrameKind.TakeControl)
    latestSocket().fireFrame(TerminalFrameKind.Ack, { ok: true }, request.sequence)
    await take

    const detach = session.detach()
    await flush()
    request = decodeTerminalFrame(latestSocket().sent.at(-1)!)
    expect(request.kind).toBe(TerminalFrameKind.Detach)
    latestSocket().fireFrame(TerminalFrameKind.Ack, { ok: true }, request.sequence)
    await detach
    expect(session.isExited).toBe(false)
  })

  it("releases the lease and kills through the host, logging non-replay host errors", async () => {
    const session = await completeSpawn()
    const controls: unknown[] = []
    session.onControlState((state) => controls.push(state))
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})

    // A host-side error that is not a replay gap is surfaced (not swallowed);
    // a replay-gap error is handled by the ReplayGap frame path instead.
    latestSocket().fireFrame(TerminalFrameKind.Error, { code: "replay_gap", message: "gap" })
    latestSocket().fireFrame(TerminalFrameKind.Error, {
      code: "permission_denied",
      message: "nope",
    })
    await flush()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain("permission_denied")

    const release = session.releaseControl()
    await flush()
    let request = decodeTerminalFrame(latestSocket().sent.at(-1)!)
    expect(request.kind).toBe(TerminalFrameKind.ReleaseControl)
    latestSocket().fireFrame(TerminalFrameKind.Ack, { ok: true }, request.sequence)
    await release
    expect(controls).toContainEqual({ role: "viewer", controllerId: null, reason: "released" })

    const kill = session.kill()
    await flush()
    request = decodeTerminalFrame(latestSocket().sent.at(-1)!)
    expect(request.kind).toBe(TerminalFrameKind.Kill)
    latestSocket().fireFrame(TerminalFrameKind.Ack, { ok: true }, request.sequence)
    await kill
    expect(session.isExited).toBe(true)
    // Killing an exited session is a no-op.
    await session.kill()
    warn.mockRestore()
  })

  it("reattaches with replay sequence and flushes bounded pending input", async () => {
    jest.useFakeTimers()
    const session = await completeSpawn()
    latestSocket().fireBytes(TerminalFrameKind.Stdout, new Uint8Array([1]), BigInt(9))
    latestSocket().fireClose()
    await session.write("queued\n")
    jest.advanceTimersByTime(1_000)
    await flush()
    expect(ticketCounter).toBe(2)
    const reconnect = latestSocket()
    expect(reconnect.url).toContain("ticket=ticket-2")
    reconnect.fireOpen()
    await flush()
    const attach = decodeTerminalFrame(reconnect.sent[0]!)
    expect(attach.kind).toBe(TerminalFrameKind.Attach)
    expect(decodeTerminalJson(attach)).toEqual({ resumeAfter: 9 })
    reconnect.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), attach.sequence)
    for (let index = 0; index < 5 && reconnect.sent.length < 2; index += 1) {
      await flush()
    }
    expect(reconnect.sent).toHaveLength(2)
    const queued = decodeTerminalFrame(reconnect.sent[1]!)
    expect(queued.kind).toBe(TerminalFrameKind.Stdin)
    expect(new TextDecoder().decode(queued.payload)).toBe("queued\n")
  })

  it("rejects missing pairing and expired tickets before opening a socket", async () => {
    configureCompanionEndpointResolver(async () => null)
    await expect(
      RemoteTerminalSession.spawn({ shell: "ignored", rows: 24, cols: 80 })
    ).rejects.toMatchObject({ code: "unpaired" })
    configureCompanionEndpointResolver(async () => ({
      ...COMPANION_ENDPOINT,
      baseUrl: "https://host",
    }))
    __setSocketTicketIssuerForTesting(async () => ({ ticket: "expired", expiresAt: 1 }))
    await expect(
      RemoteTerminalSession.spawn({ shell: "ignored", rows: 24, cols: 80 })
    ).rejects.toMatchObject({ code: "unauthorized" })
  })
})

describe("RemoteTerminalSession canonical WAN transport", () => {
  it("spawns over the ordered cognia.terminal channel without a socket ticket", async () => {
    const channel = new MockTerminalDataChannel()
    __setTerminalDataChannelResolverForTesting(() => channel as unknown as RTCDataChannel)

    const promise = RemoteTerminalSession.spawnWan({
      profileId: "profile-a",
      shell: "/bin/zsh",
      rows: 24,
      cols: 80,
    })
    await flush()
    channel.open()
    await flush()

    const request = decodeTerminalFrame(channel.sent[0])
    expect(request.kind).toBe(TerminalFrameKind.Spawn)
    expect(sockets).toHaveLength(0)
    channel.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), request.sequence)

    await expect(promise).resolves.toMatchObject({ info: { id: SESSION_ID } })
  })

  it("shares one multiplexed channel and allocates unique request sequences", async () => {
    const channel = new MockTerminalDataChannel()
    __setTerminalDataChannelResolverForTesting(() => channel as unknown as RTCDataChannel)

    const first = RemoteTerminalSession.spawnWan({ shell: "ignored", rows: 24, cols: 80 })
    await flush()
    channel.open()
    await flush()
    const firstRequest = decodeTerminalFrame(channel.sent[0])
    channel.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), firstRequest.sequence)
    await first

    const second = RemoteTerminalSession.spawnWan({ shell: "ignored", rows: 24, cols: 80 })
    for (let index = 0; index < 5 && channel.sent.length < 2; index += 1) await flush()
    expect(channel.sent).toHaveLength(2)
    const secondRequest = decodeTerminalFrame(channel.sent[1])
    expect(secondRequest.sequence).toBeGreaterThan(firstRequest.sequence)
    channel.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), secondRequest.sequence)
    await second
  })
})

it("selects the remote session adapter on Capacitor", () => {
  expect(pickRemoteSpawn()).toBeTruthy()
})

describe("cloud companion endpoint resolution (ADR-0059 C1)", () => {
  beforeEach(() => {
    // Drop the per-test stub so the production default resolver runs.
    __resetEndpointResolverForTesting()
  })

  afterEach(() => {
    setActiveRemoteEndpoint(null)
  })

  it("selects the remote session adapter for a browser paired to a server", () => {
    mockIsCapacitor = false
    mockHasWebCompanionTarget = true
    expect(pickRemoteSpawn()).toBeTruthy()
  })

  it("has no remote adapter for a web standalone build", () => {
    mockIsCapacitor = false
    mockHasWebCompanionTarget = false
    expect(pickRemoteSpawn()).toBeNull()
  })

  it("resolves the endpoint from the companion target book in a paired browser", async () => {
    mockIsCapacitor = false
    mockHasWebCompanionTarget = true
    const promise = RemoteTerminalSession.spawn({ shell: "ignored", rows: 24, cols: 80 })
    // The default resolver `import()`s the storage module, so the socket lands
    // a few extra microtask ticks later than the stubbed-resolver tests.
    for (let index = 0; index < 10 && sockets.length === 0; index += 1) await flush()
    const socket = latestSocket()
    expect(socket.url).toContain("wss://cognia.example:27890/ws/terminal")
    expect(mockCompanionStorageLoad).toHaveBeenCalled()
    socket.fireOpen()
    await flush()
    const frame = decodeTerminalFrame(socket.sent[0]!)
    socket.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), frame.sequence)
    await expect(promise).resolves.toMatchObject({ id: SESSION_ID })
  })

  it("lets an active remote host outrank the local pairing", async () => {
    // ADR-0082 precedence: a desktop driving a remote Cognia must target that
    // host, never whatever pairing happens to sit in this shell's target book.
    mockIsCapacitor = true
    setActiveRemoteEndpoint({
      baseUrl: "https://remote-host.example:27890",
      deviceId: "remote-device",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "remote-key" },
      deviceKeyThumbprint: "remote-thumbprint",
      serverVersion: "1.0.0",
    })
    const promise = RemoteTerminalSession.spawn({ shell: "ignored", rows: 24, cols: 80 })
    for (let index = 0; index < 10 && sockets.length === 0; index += 1) await flush()
    const socket = latestSocket()
    expect(socket.url).toContain("wss://remote-host.example:27890/ws/terminal")
    expect(mockCompanionStorageLoad).not.toHaveBeenCalled()
    socket.fireOpen()
    await flush()
    const frame = decodeTerminalFrame(socket.sent[0]!)
    socket.fireFrame(TerminalFrameKind.SessionSnapshot, sessionInfo(), frame.sequence)
    await expect(promise).resolves.toMatchObject({ id: SESSION_ID })
  })

  it("still reports unpaired for a web standalone build", async () => {
    mockIsCapacitor = false
    mockHasWebCompanionTarget = false
    await expect(
      RemoteTerminalSession.spawn({ shell: "ignored", rows: 24, cols: 80 })
    ).rejects.toMatchObject({ code: "unpaired" })
    expect(mockCompanionStorageLoad).not.toHaveBeenCalled()
  })
})
