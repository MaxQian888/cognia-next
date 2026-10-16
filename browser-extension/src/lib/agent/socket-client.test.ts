import {
  HEARTBEAT_MS,
  backoffMs,
  browserCompanionSocketUrl,
  createSocketClient,
  type SocketLike,
  type SocketState,
} from "./socket-client"
import { AgentOperationError } from "./protocol"

class FakeSocket implements SocketLike {
  readyState = 0
  sent: unknown[] = []
  closed: [number | undefined, string | undefined] | null = null
  onopen: SocketLike["onopen"] = null
  onmessage: SocketLike["onmessage"] = null
  onclose: SocketLike["onclose"] = null
  onerror: SocketLike["onerror"] = null
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close(code?: number, reason?: string) {
    this.closed = [code, reason]
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(
  options: {
    ticket?: () => Promise<string>
    execute?: (op: string, args: Record<string, unknown>) => Promise<unknown>
  } = {}
) {
  const sockets: FakeSocket[] = []
  const states: SocketState[] = []
  const drive: boolean[] = []
  let hints = 0
  let clock = 0
  let nextHandle = 0
  const timeouts = new Map<number, { at: number; callback: () => void }>()
  const intervals = new Map<number, { every: number; callback: () => void }>()
  const client = createSocketClient({
    issueTicket: options.ticket ?? (async () => "t1"),
    socketUrl: (ticket) => `ws://host/ws?ticket=${ticket}`,
    createSocket: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    execute: async (op, args) => (options.execute ? options.execute(op, args) : { op, args }),
    extensionVersion: "1.2.3",
    features: ["agent"],
    onStatusHint: () => {
      hints += 1
    },
    onDrive: (allowed) => drive.push(allowed),
    onState: (state) => states.push(state),
    now: () => clock,
    random: () => 0.5,
    setTimeout: (callback, ms) => {
      timeouts.set(++nextHandle, { at: clock + ms, callback })
      return nextHandle
    },
    clearTimeout: (handle) => {
      timeouts.delete(handle as number)
    },
    setInterval: (callback, ms) => {
      intervals.set(++nextHandle, { every: ms, callback })
      return nextHandle
    },
    clearInterval: (handle) => {
      intervals.delete(handle as number)
    },
  })
  const advance = async (ms: number) => {
    clock += ms
    for (const [handle, timer] of [...timeouts]) {
      if (timer.at <= clock) {
        timeouts.delete(handle)
        timer.callback()
      }
    }
    await flush()
  }
  return {
    client,
    sockets,
    states,
    drive,
    hints: () => hints,
    timeouts,
    intervals,
    advance,
  }
}

describe("backoffMs", () => {
  it("doubles to a one-minute ceiling with jitter", () => {
    expect(backoffMs(0, 0.5)).toBe(1_000)
    expect(backoffMs(3, 0.5)).toBe(8_000)
    expect(backoffMs(20, 0.5)).toBe(60_000)
    expect(backoffMs(0, 0)).toBe(800)
    expect(backoffMs(0, 1)).toBe(1_200)
  })
})

describe("browserCompanionSocketUrl", () => {
  it("swaps the scheme and carries the ticket", () => {
    expect(browserCompanionSocketUrl("http://127.0.0.1:27891", "a b")).toBe(
      "ws://127.0.0.1:27891/ws/browser-companion?ticket=a+b"
    )
    expect(browserCompanionSocketUrl("https://host.test/", "x")).toBe(
      "wss://host.test/ws/browser-companion?ticket=x"
    )
  })
})

describe("createSocketClient", () => {
  it("says hello, heartbeats as text, and reports the welcome", async () => {
    const h = harness()
    h.client.start()
    await flush()
    const socket = h.sockets[0]!
    expect(socket.url).toBe("ws://host/ws?ticket=t1")
    socket.open()
    expect(socket.sent).toEqual([
      { t: "hello", v: 1, extensionVersion: "1.2.3", features: ["agent"] },
    ])
    expect([...h.intervals.values()][0]?.every).toBe(HEARTBEAT_MS)
    ;[...h.intervals.values()][0]?.callback()
    expect(socket.sent.at(-1)).toEqual({ t: "heartbeat" })

    socket.receive({ t: "welcome", v: 1, connectionId: "c1", driveAllowed: true })
    expect(h.client.state()).toEqual({ kind: "connected", connectionId: "c1", driveAllowed: true })
    expect(h.drive).toEqual([true])
    expect(h.hints()).toBe(1)

    socket.receive({ t: "drive", allowed: false })
    socket.receive({ t: "status", at: 5 })
    expect(h.drive).toEqual([true, false])
    expect(h.client.state()).toMatchObject({ driveAllowed: false })
    expect(h.hints()).toBe(2)
  })

  it("answers operations with the executor's value or its refusal code", async () => {
    const h = harness({
      execute: async (op, args) => {
        if (op === "act") throw new AgentOperationError("browser_user_takeover", "taken over")
        return { echoed: args.session }
      },
    })
    h.client.start()
    await flush()
    const socket = h.sockets[0]!
    socket.open()
    socket.receive({ t: "op", id: "1", op: "snapshot", args: { session: "s" }, deadlineMs: 5_000 })
    socket.receive({ t: "op", id: "2", op: "act", args: {}, deadlineMs: 5_000 })
    socket.receive({ t: "op", id: "3", op: "format_disk", args: {} })
    await flush()
    expect(socket.sent.slice(1)).toEqual([
      {
        t: "result",
        id: "3",
        ok: false,
        error: { code: "browser_operation_unknown", message: expect.any(String) },
      },
      { t: "result", id: "1", ok: true, value: { echoed: "s" } },
      {
        t: "result",
        id: "2",
        ok: false,
        error: { code: "browser_user_takeover", message: "taken over" },
      },
    ])
  })

  it("refuses an answer too large for the socket", async () => {
    const h = harness({ execute: async () => "x".repeat(16 * 1024 * 1024) })
    h.client.start()
    await flush()
    const socket = h.sockets[0]!
    socket.open()
    socket.receive({ t: "op", id: "1", op: "screenshot", args: {} })
    await flush()
    expect(socket.sent.at(-1)).toMatchObject({
      ok: false,
      error: { code: "browser_result_too_large" },
    })
  })

  it("does not answer on a socket that was replaced while the operation ran", async () => {
    let release: (value: unknown) => void = () => undefined
    const h = harness({ execute: () => new Promise((resolve) => (release = resolve)) })
    h.client.start()
    await flush()
    const first = h.sockets[0]!
    first.open()
    first.receive({ t: "op", id: "1", op: "snapshot", args: {} })
    first.drop()
    release({ late: true })
    await flush()
    expect(first.sent).toHaveLength(1)
  })

  it("reconnects with backoff after a drop, resetting after a welcome", async () => {
    const h = harness()
    h.client.start()
    await flush()
    h.sockets[0]!.drop()
    expect(h.client.state()).toEqual({ kind: "waiting", retryAt: 1_000, code: null })
    await h.advance(1_000)
    expect(h.sockets).toHaveLength(2)
    h.sockets[1]!.drop()
    expect(h.client.state()).toMatchObject({ retryAt: 3_000 })
    await h.advance(2_000)
    h.sockets[2]!.open()
    h.sockets[2]!.receive({ t: "welcome", connectionId: "c", driveAllowed: false })
    h.sockets[2]!.drop()
    expect(h.client.state()).toMatchObject({ retryAt: 4_000 })
  })

  it("waits five minutes on a standing refusal, and is not hurried by start()", async () => {
    const h = harness({
      ticket: async () => {
        throw Object.assign(new Error("no"), { code: "socket_capability_required" })
      },
    })
    h.client.start()
    await flush()
    expect(h.client.state()).toEqual({
      kind: "waiting",
      retryAt: 300_000,
      code: "socket_capability_required",
    })
    h.client.start()
    await flush()
    expect(h.timeouts.size).toBe(1)
    expect(h.sockets).toHaveLength(0)
  })

  it("treats a policy close as a refusal", async () => {
    const h = harness()
    h.client.start()
    await flush()
    h.sockets[0]!.open()
    h.sockets[0]!.drop(1008, "device revoked")
    expect(h.client.state()).toEqual({ kind: "waiting", retryAt: 300_000, code: "device revoked" })
  })

  it("retries a transient wait at once when asked for", async () => {
    let fail = true
    const h = harness({
      ticket: async () => {
        if (fail) throw new Error("ECONNREFUSED")
        return "t2"
      },
    })
    h.client.start()
    await flush()
    expect(h.client.state()).toMatchObject({ kind: "waiting", code: null })
    fail = false
    h.client.start()
    await flush()
    expect(h.sockets[0]?.url).toContain("t2")
    expect(h.timeouts.size).toBe(0)
  })

  it("retryNow skips a refusal's wait", async () => {
    let refuse = true
    const h = harness({
      ticket: async () => {
        if (refuse) throw Object.assign(new Error("no"), { code: "device_unavailable" })
        return "t3"
      },
    })
    h.client.start()
    await flush()
    refuse = false
    h.client.retryNow()
    await flush()
    expect(h.sockets).toHaveLength(1)
  })

  it("stops: closes the socket, clears timers, and ignores a late ticket", async () => {
    let resolveTicket: (ticket: string) => void = () => undefined
    const h = harness({ ticket: () => new Promise((resolve) => (resolveTicket = resolve)) })
    h.client.start()
    h.client.stop()
    resolveTicket("late")
    await flush()
    expect(h.sockets).toHaveLength(0)
    expect(h.client.state()).toEqual({ kind: "stopped" })

    const open = harness()
    open.client.start()
    await flush()
    open.sockets[0]!.open()
    open.client.stop()
    expect(open.sockets[0]!.closed).toEqual([1000, "not needed"])
    expect(open.intervals.size).toBe(0)
    open.sockets[0]!.drop()
    expect(open.timeouts.size).toBe(0)
  })
})
