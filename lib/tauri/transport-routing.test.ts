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
  const destroy = jest.fn()
  const transport = {
    call: jest.fn(async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args })
      return `${tag}:${name}` as unknown
    }) as Transport["call"],
    subscribe: jest.fn((event: string, _handler: (payload: unknown) => void) => {
      subscriptions.push(event)
      return unsubscribe
    }) as Transport["subscribe"],
    destroy,
  } as Transport & { destroy: () => void }
  return { transport, calls, subscriptions, unsubscribe, destroy, tag }
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

  it("keeps service commands on the local Tauri plane when no remote is active", async () => {
    const local = fakeTransport("local")
    const routing = new RoutingTransport(local.transport)

    const result = await routing.call("integration_ingress_poll", { limit: 100 })

    expect(result).toBe("local:integration_ingress_poll")
    expect(local.calls).toEqual([{ name: "integration_ingress_poll", args: { limit: 100 } }])
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

  it("keeps unclassified commands local instead of transparently redirecting them", async () => {
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)
    setActiveRemoteTransport(remote.transport)

    const result = await routing.call("future_renderer_only_command")

    expect(result).toBe("local:future_renderer_only_command")
    expect(local.calls).toHaveLength(1)
    expect(remote.calls).toHaveLength(0)
  })

  it("keeps the caller's own client data plane local while a remote host is active", async () => {
    // These carry a `client.*` capability and are `target: "execution"` only so
    // a paired phone can reach its own mirror over the wire. On the desktop the
    // data is this machine's: a theme change or a plugin toggle must not land
    // on the selected remote Host.
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)
    setActiveRemoteTransport(remote.transport)

    await routing.call("app_settings_update", { theme: "dark" })
    await routing.call("plugin_set_enabled", { id: "p", enabled: true })
    await routing.call("register_push_token", { token: "t" })
    await routing.call("session_list", {})

    expect(local.calls.map((call) => call.name)).toEqual([
      "app_settings_update",
      "plugin_set_enabled",
      "register_push_token",
      "session_list",
    ])
    expect(remote.calls).toHaveLength(0)
  })

  it("still follows the active remote for commands the remote host owns", async () => {
    // The counterpart: `terminal_exec` is `execution` with a `terminal.open`
    // capability — it runs on the machine being driven, not on this one.
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)
    setActiveRemoteTransport(remote.transport)

    await routing.call("terminal_exec", { command: "ls" })

    expect(remote.calls.map((call) => call.name)).toEqual(["terminal_exec"])
    expect(local.calls).toHaveLength(0)
  })

  it("rejects service-only commands from the device routing plane", async () => {
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const routing = new RoutingTransport(local.transport)
    setActiveRemoteTransport(remote.transport)

    await expect(routing.call("keyring_secret_get", { key: "secret" })).rejects.toThrow(
      "service-only"
    )
    expect(local.calls).toHaveLength(0)
    expect(remote.calls).toHaveLength(0)
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
    await routing.call("git_status")
    setActiveRemoteTransport(null)
    await routing.call("git_log")

    expect(remote.calls.map((c) => c.name)).toEqual(["git_status"])
    expect(local.calls.map((c) => c.name)).toEqual(["git_log"])
  })

  it("routes binary transcript media to the active host", async () => {
    const local = fakeTransport("local")
    const remote = fakeTransport("remote")
    const readBinary = jest.fn(async () => ({
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
    }))
    remote.transport.readBinary = readBinary
    const routing = new RoutingTransport(local.transport)
    setActiveRemoteTransport(remote.transport)

    await expect(
      routing.readBinary({
        kind: "session-media",
        sessionId: "s1",
        hash: "a".repeat(64),
        variant: "thumbnail",
      })
    ).resolves.toMatchObject({ mediaType: "image/png" })

    expect(readBinary).toHaveBeenCalledTimes(1)
  })

  it("disposes the previous remote transport on switch and deactivate", () => {
    const local = fakeTransport("local")
    const first = fakeTransport("first")
    const second = fakeTransport("second")
    const routing = new RoutingTransport(local.transport)
    expect(routing).toBeDefined()

    setActiveRemoteTransport(first.transport)
    setActiveRemoteTransport(second.transport)
    expect(first.destroy).toHaveBeenCalledTimes(1)

    setActiveRemoteTransport(null)
    expect(second.destroy).toHaveBeenCalledTimes(1)
    expect(local.destroy).not.toHaveBeenCalled()
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
    setActiveRemoteEndpoint({
      baseUrl: "https://host:27890",
      deviceId: "device-1",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      serverVersion: "1.0.0",
    })

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
      deviceId: "device-1",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      serverVersion: "1.0.0",
      serverFingerprint: "sha256:remote-spki",
    }
    setActiveRemoteEndpoint(endpoint)
    expect(getActiveRemoteEndpoint()).toEqual(endpoint)
    setActiveRemoteEndpoint(null)
    expect(getActiveRemoteEndpoint()).toBeNull()
  })
})
