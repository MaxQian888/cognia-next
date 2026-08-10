/**
 * BridgeClient behavior against a scripted fake socket (ADR-0059 T-B1).
 *
 * @jest-environment node
 */
import { BridgeClient, type WebSocketLike } from "./bridge-client"
import { BRIDGE_PROTOCOL_VERSION } from "./protocol"
import { HEADLESS_CATALOG_HASH, HEADLESS_CONTRACT_VERSION } from "./headless-contract-identity"

type Listener = (event: {
  data?: string
  error?: unknown
  message?: unknown
  code?: unknown
}) => void

class FakeSocket implements WebSocketLike {
  sent: string[] = []
  closed = false
  private listeners = new Map<string, Listener[]>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.closed = true
    this.fire("close", {})
  }

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  fire(
    type: string,
    event: { data?: string; error?: unknown; message?: unknown; code?: unknown }
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  serverSend(frame: unknown): void {
    this.fire("message", { data: JSON.stringify(frame) })
  }

  lastSent(): unknown {
    return JSON.parse(this.sent[this.sent.length - 1])
  }
}

function helloAck(
  protocol: number = BRIDGE_PROTOCOL_VERSION,
  catalogHash: string = HEADLESS_CATALOG_HASH,
  accountId: string = "local_acct_a"
) {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: "hello_ack",
    serverVersion: "0.9.0",
    protocol,
    accountId,
    catalogHash,
    contractVersion: HEADLESS_CONTRACT_VERSION,
  }
}

interface Harness {
  client: BridgeClient
  sockets: FakeSocket[]
  urls: string[]
  states: string[]
  scheduled: Array<{ fn: () => void; ms: number }>
  refreshed: string[]
}

function makeClient(
  overrides: Partial<ConstructorParameters<typeof BridgeClient>[0]> = {}
): Harness {
  const sockets: FakeSocket[] = []
  const urls: string[] = []
  const states: string[] = []
  const scheduled: Array<{ fn: () => void; ms: number }> = []
  const refreshed: string[] = []
  const client = new BridgeClient({
    url: "wss://127.0.0.1:7890/internal/bridge",
    token: "tok-initial",
    accountId: "local_acct_a",
    brainVersion: "0.0.0-test",
    wsFactory: (url) => {
      urls.push(url)
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    },
    schedule: (fn, ms) => {
      const entry = { fn, ms }
      scheduled.push(entry)
      return () => {
        const idx = scheduled.indexOf(entry)
        if (idx >= 0) scheduled.splice(idx, 1)
      }
    },
    now: () => 1751400000000,
    random: () => 1, // deterministic jitter (full base delay)
    onStateChange: (state) => states.push(state),
    onTokenRefresh: (token) => refreshed.push(token),
    rss: () => ({ rssBytes: 123456789, lastFlushAt: 1751399990000 }),
    ...overrides,
  })
  return { client, sockets, urls, states, scheduled, refreshed }
}

async function handshake(h: Harness): Promise<void> {
  const connected = h.client.connect()
  h.sockets[h.sockets.length - 1].fire("open", {})
  h.sockets[h.sockets.length - 1].serverSend(helloAck())
  await connected
}

describe("BridgeClient", () => {
  it("sends hello on open and resolves connect on hello_ack", async () => {
    const h = makeClient()
    await handshake(h)
    const hello = JSON.parse(h.sockets[0].sent[0]) as Record<string, unknown>
    expect(hello.type).toBe("hello")
    expect(hello.role).toBe("brain")
    expect(hello.accountId).toBe("local_acct_a")
    expect(hello.protocol).toBe(BRIDGE_PROTOCOL_VERSION)
    expect(h.client.getState()).toBe("connected")
    expect(h.urls[0]).toContain("?token=tok-initial")
  })

  it("dispatches event frames to listen handlers with the raw payload", async () => {
    const h = makeClient()
    await handshake(h)
    const received: unknown[] = []
    const unlisten = await h.client.listen("companion://sync-pull-request", (e) =>
      received.push(e.payload)
    )
    h.sockets[0].serverSend({
      v: BRIDGE_PROTOCOL_VERSION,
      type: "event",
      event: "companion://sync-pull-request",
      payload: { request_id: "r1", table: "sessions", since: 0, account_id: "local_acct_a" },
    })
    expect(received).toEqual([
      { request_id: "r1", table: "sessions", since: 0, account_id: "local_acct_a" },
    ])
    unlisten()
    h.sockets[0].serverSend({
      v: BRIDGE_PROTOCOL_VERSION,
      type: "event",
      event: "companion://sync-pull-request",
      payload: {},
    })
    expect(received).toHaveLength(1)
  })

  it("invoke sends the respond frame with the args verbatim", async () => {
    const h = makeClient()
    await handshake(h)
    await h.client.invoke("companion_sync_pull_response", {
      requestId: "r1",
      delta: { rows: [] },
      error: null,
    })
    expect(h.sockets[0].lastSent()).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: "respond",
      command: "companion_sync_pull_response",
      payload: { requestId: "r1", delta: { rows: [] }, error: null },
    })
  })

  it("invoke while disconnected drops loudly instead of rejecting", async () => {
    const logs: string[] = []
    const h = makeClient({ log: (_level, message) => logs.push(message), reconnect: false })
    await expect(
      h.client.invoke("companion_sync_pull_response", { requestId: "r1" })
    ).resolves.toBeNull()
    expect(logs.some((l) => l.includes("dropped"))).toBe(true)
  })

  it("logs the socket error cause while redacting service tokens", () => {
    const logs: string[] = []
    const h = makeClient({ log: (_level, message) => logs.push(message), reconnect: false })
    void h.client.connect()
    const cause = new Error(
      "Unexpected server response: 401 at wss://127.0.0.1/internal/bridge?token=secret-value"
    )
    h.sockets[0].fire("error", { error: new Error("WebSocket handshake failed", { cause }) })

    expect(logs).toContain(
      "bridge socket error: WebSocket handshake failed: Unexpected server response: 401 at wss://127.0.0.1/internal/bridge?token=[redacted]"
    )
    expect(logs.join("\n")).not.toContain("secret-value")
  })

  it("answers pings with a pong carrying the RSS gauge", async () => {
    const h = makeClient()
    await handshake(h)
    h.sockets[0].serverSend({ v: BRIDGE_PROTOCOL_VERSION, type: "ping", ts: 42 })
    expect(h.sockets[0].lastSent()).toEqual({
      v: BRIDGE_PROTOCOL_VERSION,
      type: "pong",
      ts: 1751400000000,
      rssBytes: 123456789,
      lastFlushAt: 1751399990000,
    })
  })

  it("token_refresh updates the token used by the next reconnect", async () => {
    const h = makeClient()
    await handshake(h)
    h.sockets[0].serverSend({
      v: BRIDGE_PROTOCOL_VERSION,
      type: "token_refresh",
      token: "tok-2",
    })
    expect(h.refreshed).toEqual(["tok-2"])

    // Server drops the connection → scheduled reconnect uses the new token.
    h.sockets[0].fire("close", {})
    expect(h.client.getState()).toBe("reconnecting")
    expect(h.scheduled).toHaveLength(1)
    h.scheduled[0].fn()
    expect(h.urls[1]).toContain("?token=tok-2")

    // Re-hello on the fresh socket completes the recovery.
    h.sockets[1].fire("open", {})
    expect((JSON.parse(h.sockets[1].sent[0]) as { type: string }).type).toBe("hello")
    h.sockets[1].serverSend(helloAck())
    expect(h.client.getState()).toBe("connected")
  })

  it("escalates the reconnect backoff and resets it after a success", async () => {
    const h = makeClient()
    await handshake(h)

    // First drop → 250ms (deterministic jitter = full base).
    h.sockets[0].fire("close", {})
    expect(h.scheduled[0].ms).toBe(250)
    h.scheduled.shift()!.fn()
    // Second consecutive failure → 1000ms.
    h.sockets[1].fire("close", {})
    expect(h.scheduled[0].ms).toBe(1000)
    h.scheduled.shift()!.fn()

    // Recovery resets the counter.
    h.sockets[2].fire("open", {})
    h.sockets[2].serverSend(helloAck())
    expect(h.client.getState()).toBe("connected")
    h.sockets[2].fire("close", {})
    expect(h.scheduled[0].ms).toBe(250)
  })

  it("rejects connect on a protocol mismatch and closes", async () => {
    const h = makeClient()
    const connected = h.client.connect()
    h.sockets[0].fire("open", {})
    h.sockets[0].serverSend(helloAck(99))
    await expect(connected).rejects.toThrow(/protocol mismatch/)
    expect(h.client.getState()).toBe("closed")
  })

  it("rejects connect when hello_ack belongs to another account", async () => {
    const h = makeClient()
    const connected = h.client.connect()
    h.sockets[0].fire("open", {})
    h.sockets[0].serverSend(
      helloAck(BRIDGE_PROTOCOL_VERSION, HEADLESS_CATALOG_HASH, "local_acct_b")
    )
    await expect(connected).rejects.toThrow(/account mismatch/)
    expect(h.client.getState()).toBe("closed")
  })

  it("rejects connect when the server catalog differs", async () => {
    const h = makeClient()
    const connected = h.client.connect()
    h.sockets[0].fire("open", {})
    h.sockets[0].serverSend(helloAck(BRIDGE_PROTOCOL_VERSION, "stale-catalog"))
    await expect(connected).rejects.toThrow(/contract mismatch/)
    expect(h.client.getState()).toBe("closed")
  })

  it("close() stops reconnection for good", async () => {
    const h = makeClient()
    await handshake(h)
    h.client.close()
    expect(h.client.getState()).toBe("closed")
    expect(h.sockets[0].closed).toBe(true)
    // No timers pending, and a late close event does not resurrect it.
    expect(h.scheduled).toHaveLength(0)
    expect(h.client.getState()).toBe("closed")
  })
})
