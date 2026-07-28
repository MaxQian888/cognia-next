import type { Transport } from "./transport-types"
import {
  RoutingTransport,
  __resetRoutingForTests,
  getActiveRemoteEndpoint,
  getActiveRemoteTransport,
  isRemoteHostActive,
  setActiveRemoteEndpoint,
  setActiveRemoteTransport,
  subscribeActiveRemoteTransport,
} from "./transport-routing"

/** Minimal Transport fake that records where each call/subscribe landed. */
function fakeTransport(tag: string) {
  const calls: Array<{ name: string; args?: Record<string, unknown> }> = []
  const subscriptions: string[] = []
  const unsubscribe = jest.fn()
  const transport: Transport = {
    call: jest.fn(async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args })
      return `${tag}:${name}` as unknown
    }) as Transport["call"],
    subscribe: jest.fn((event: string, _handler: (payload: unknown) => void) => {
      subscriptions.push(event)
      return unsubscribe
    }) as Transport["subscribe"],
  }
  return { transport, calls, subscriptions, unsubscribe, tag }
}

describe("RoutingTransport", () => {
  beforeEach(() => {
    __resetRoutingForTests()
  })
  afterEach(() => {
    __resetRoutingForTests()
  })

  it("routes to local when no remote is active (zero-regression baseline)", async () => {
    const local = fakeTransport("local")
    const routing = new RoutingTransport(local.transport)

    const result = await routing.call("git_status", { cwd: "/repo" })

    expect(result).toBe("local:git_status")
    expect(local.calls).toEqual([{ name: "git_status", args: { cwd: "/repo" } }])
    expect(getActiveRemoteTransport()).toBeNull()
  })

  it("routes to the active remote transport once one is installed", async () => {
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)

    setActiveRemoteTransport(remote.transport)
    const result = await routing.call("git_status")

    expect(result).toBe("remote:git_status")
    expect(remote.calls).toHaveLength(1)
    expect(local.calls).toHaveLength(0)
    expect(getActiveRemoteTransport()).toBe(remote.transport)
  })

  it("keeps desktop webview and relay commands local while a remote host is active", async () => {
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)
    setActiveRemoteTransport(remote.transport)

    await routing.call("codeserver_embed_create", { url: "http://127.0.0.1:41000/" })
    await routing.call("codeserver_remote_relay_ensure", { sessionId: "session-1" })

    expect(local.calls.map((call) => call.name)).toEqual([
      "codeserver_embed_create",
      "codeserver_remote_relay_ensure",
    ])
    expect(remote.calls).toHaveLength(0)
  })

  it("falls back to local after the remote is cleared", async () => {
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)

    setActiveRemoteTransport(remote.transport)
    await routing.call("first")
    setActiveRemoteTransport(null)
    await routing.call("second")

    expect(remote.calls.map((c) => c.name)).toEqual(["first"])
    expect(local.calls.map((c) => c.name)).toEqual(["second"])
  })

  it("moves an existing subscription across active-host changes without leaking listeners", () => {
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)

    const off = routing.subscribe("evt", () => {})
    expect(local.subscriptions).toEqual(["evt"])

    setActiveRemoteTransport(remote.transport)
    expect(local.unsubscribe).toHaveBeenCalledTimes(1)
    expect(remote.subscriptions).toEqual(["evt"])

    setActiveRemoteTransport(null)
    expect(remote.unsubscribe).toHaveBeenCalledTimes(1)
    expect(local.subscriptions).toEqual(["evt", "evt"])

    off()
    off()
    expect(local.unsubscribe).toHaveBeenCalledTimes(2)

    setActiveRemoteTransport(remote.transport)
    expect(remote.subscriptions).toEqual(["evt"])
    expect(remote.unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe("active-remote holder", () => {
  beforeEach(() => {
    __resetRoutingForTests()
  })
  afterEach(() => {
    __resetRoutingForTests()
  })

  it("notifies listeners only on real changes", () => {
    const remote = fakeTransport("remote")
    const listener = jest.fn()
    subscribeActiveRemoteTransport(listener)

    setActiveRemoteTransport(remote.transport)
    setActiveRemoteTransport(remote.transport) // unchanged → no fire
    setActiveRemoteTransport(null)

    expect(listener.mock.calls).toEqual([[remote.transport], [null]])
  })

  it("stops notifying after unsubscribe", () => {
    const remote = fakeTransport("remote")
    const listener = jest.fn()
    const off = subscribeActiveRemoteTransport(listener)

    off()
    setActiveRemoteTransport(remote.transport)

    expect(listener).not.toHaveBeenCalled()
  })

  it("__resetRoutingForTests clears state and listeners", () => {
    const remote = fakeTransport("remote")
    const listener = jest.fn()
    subscribeActiveRemoteTransport(listener)
    setActiveRemoteTransport(remote.transport)
    setActiveRemoteEndpoint({ baseUrl: "https://host:27890", deviceJwt: "jwt" })

    __resetRoutingForTests()

    expect(getActiveRemoteTransport()).toBeNull()
    expect(getActiveRemoteEndpoint()).toBeNull()
    listener.mockClear()
    setActiveRemoteTransport(remote.transport)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe("active-remote endpoint + isRemoteHostActive", () => {
  beforeEach(() => {
    __resetRoutingForTests()
  })
  afterEach(() => {
    __resetRoutingForTests()
  })

  it("isRemoteHostActive tracks the active transport", () => {
    const remote = fakeTransport("remote")
    expect(isRemoteHostActive()).toBe(false)
    setActiveRemoteTransport(remote.transport)
    expect(isRemoteHostActive()).toBe(true)
    setActiveRemoteTransport(null)
    expect(isRemoteHostActive()).toBe(false)
  })

  it("stores and clears the raw WebSocket endpoint descriptor", () => {
    expect(getActiveRemoteEndpoint()).toBeNull()
    const endpoint = {
      baseUrl: "https://box.example:27890",
      deviceJwt: "device-jwt",
      serverFingerprint: "sha256:remote-spki",
    }
    setActiveRemoteEndpoint(endpoint)
    expect(getActiveRemoteEndpoint()).toEqual(endpoint)
    setActiveRemoteEndpoint(null)
    expect(getActiveRemoteEndpoint()).toBeNull()
  })
})
