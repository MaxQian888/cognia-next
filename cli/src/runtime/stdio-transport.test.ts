/**
 * @jest-environment node
 */
import { PassThrough } from "node:stream"

import { CLI_HOST_RPC_HANDLERS, StdioTransport, type SidecarHandle } from "./stdio-transport"
import { SIDECAR_EVENT, AGENT_EVENT, A2UI_EVENT } from "./protocol"

function makeHandle() {
  const stdout = new PassThrough()
  const writes: string[] = []
  let exitCb: ((code: number | null) => void) | null = null
  const handle: SidecarHandle = {
    stdin: { write: (chunk) => void writes.push(chunk) },
    stdout,
    onExit: (cb) => {
      exitCb = cb
    },
  }
  return {
    handle,
    writes,
    /** Push one JSON-line onto the sidecar's stdout. */
    emit: (obj: unknown) => stdout.write(JSON.stringify(obj) + "\n"),
    raw: (line: string) => stdout.write(line + "\n"),
    exit: (code: number | null = 0) => exitCb?.(code),
    parsedWrites: () => writes.map((w) => JSON.parse(w.trim())),
  }
}

/** readline emits 'line' asynchronously; yield a microtask + macrotask. */
const flush = () => new Promise((r) => setImmediate(r))

describe("StdioTransport — stdout → subscribers", () => {
  it("forwards parsed lines to claude://message subscribers", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const got: unknown[] = []
    t.subscribe(SIDECAR_EVENT, (p) => got.push(p))
    h.emit({ type: "event", sessionId: "s1", event: { foo: 1 } })
    await flush()
    expect(got).toEqual([{ type: "event", sessionId: "s1", event: { foo: 1 } }])
  })

  it("ignores non-JSON noise on stdout", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const got: unknown[] = []
    t.subscribe(SIDECAR_EVENT, (p) => got.push(p))
    h.raw("not json at all")
    h.emit({ type: "log", level: "info", message: "ok" })
    await flush()
    expect(got).toEqual([{ type: "log", level: "info", message: "ok" }])
  })

  it("routes a2ui_dispatch to BOTH the a2ui channel and claude://message", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const main: unknown[] = []
    const a2ui: unknown[] = []
    t.subscribe(SIDECAR_EVENT, (p) => main.push(p))
    t.subscribe(A2UI_EVENT, (p) => a2ui.push(p))
    h.emit({ type: "a2ui_dispatch", sessionId: "s1" })
    await flush()
    expect(a2ui).toHaveLength(1)
    expect(main).toHaveLength(1)
  })

  it("routes agent_event to BOTH the canonical and raw channels", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const raw: unknown[] = []
    const canonical: unknown[] = []
    t.subscribe(SIDECAR_EVENT, (payload) => raw.push(payload))
    t.subscribe(AGENT_EVENT, (payload) => canonical.push(payload))
    h.emit({ type: "agent_event", envelope: { sessionId: "s1" } })
    await flush()
    expect(canonical).toHaveLength(1)
    expect(raw).toHaveLength(1)
  })

  it("unsubscribe is idempotent and stops delivery", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const got: unknown[] = []
    const off = t.subscribe(SIDECAR_EVENT, (p) => got.push(p))
    off()
    off() // second call is a safe no-op
    h.emit({ type: "log" })
    await flush()
    expect(got).toHaveLength(0)
  })

  it("a throwing subscriber does not break the read loop", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const got: unknown[] = []
    t.subscribe(SIDECAR_EVENT, () => {
      throw new Error("boom")
    })
    t.subscribe(SIDECAR_EVENT, (p) => got.push(p))
    h.emit({ type: "log" })
    await flush()
    expect(got).toHaveLength(1)
  })
})

describe("StdioTransport — readiness", () => {
  it("whenReady resolves on the ready line", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const ready = t.whenReady(1000)
    expect(t.isReady()).toBe(false)
    h.emit({ type: "ready", sidecarVersion: "0.1.0" })
    await expect(ready).resolves.toBeUndefined()
    expect(t.isReady()).toBe(true)
  })

  it("whenReady resolves immediately if already ready", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    h.emit({ type: "ready" })
    await flush()
    await expect(t.whenReady(1000)).resolves.toBeUndefined()
  })

  it("claude_sidecar_status reflects readiness", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    expect(await t.call("claude_sidecar_status")).toEqual({ ready: false })
    h.emit({ type: "ready" })
    await flush()
    expect(await t.call("claude_sidecar_status")).toEqual({ ready: true })
  })

  it("whenReady rejects when the sidecar exits first", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const ready = t.whenReady(1000)
    h.exit(1)
    await expect(ready).rejects.toThrow(/exited before ready/)
  })

  it("whenReady rejects on timeout", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    await expect(t.whenReady(10)).rejects.toThrow(/did not become ready/)
  })
})

describe("StdioTransport — call → stdin", () => {
  it("writes a send line for claude_send", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    await t.call("claude_send", { sessionId: "s1", prompt: "hi", options: { model: "m" } })
    expect(h.parsedWrites()).toEqual([
      { type: "send", sessionId: "s1", prompt: "hi", options: { model: "m" } },
    ])
  })

  it("writes a permission_response for claude_approve", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    await t.call("claude_approve", { sessionId: "s1", requestId: "r1", decision: "deny" })
    expect(h.parsedWrites()[0]).toMatchObject({
      type: "permission_response",
      decision: "deny",
      requestId: "r1",
    })
  })

  it("rejects an unsupported command", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    await expect(t.call("claude_restart_sidecar")).rejects.toThrow(/unsupported command/)
  })

  it("rejects writes after the sidecar exited", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    h.exit(0)
    await flush()
    await expect(t.call("claude_send", { sessionId: "s1", prompt: "x" })).rejects.toThrow(
      /not running/
    )
  })

  it("emits sidecar_exited to subscribers on exit", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const got: Array<{ type?: string }> = []
    t.subscribe(SIDECAR_EVENT, (p) => got.push(p as { type?: string }))
    h.exit(0)
    await flush()
    expect(got.some((m) => m.type === "sidecar_exited")).toBe(true)
  })
})

describe("StdioTransport — host_rpc", () => {
  it("answers workspace.portEnv with null so a shell spawns without port variables", async () => {
    const h = makeHandle()
    const t = new StdioTransport(h.handle)
    const seen: unknown[] = []
    t.subscribe(SIDECAR_EVENT, (p) => seen.push(p))
    h.emit({ type: "host_rpc", rpcId: "r1", method: "workspace.portEnv", params: { cwd: "/w" } })
    await flush()
    await flush()
    expect(h.parsedWrites()).toEqual([
      { type: "host_rpc_result", rpcId: "r1", ok: true, result: null },
    ])
    // Answered by the host, like the Rust supervisor: never forwarded.
    expect(seen).toEqual([])
  })

  it("refuses an unsupported method at once instead of letting it time out", async () => {
    const h = makeHandle()
    new StdioTransport(h.handle)
    h.emit({ type: "host_rpc", rpcId: "r2", method: "jobs.spawn", params: {} })
    await flush()
    await flush()
    expect(h.parsedWrites()).toEqual([
      {
        type: "host_rpc_result",
        rpcId: "r2",
        ok: false,
        error: 'host_rpc method "jobs.spawn" is not available on the CLI host',
      },
    ])
  })

  it("does not resolve inherited object keys as methods", async () => {
    const h = makeHandle()
    new StdioTransport(h.handle)
    h.emit({ type: "host_rpc", rpcId: "r3", method: "toString", params: {} })
    await flush()
    await flush()
    expect(h.parsedWrites()[0]).toMatchObject({ rpcId: "r3", ok: false })
  })

  it("sends a handler failure back as ok:false and supports injected handlers", async () => {
    const h = makeHandle()
    new StdioTransport(h.handle, {
      hostRpc: {
        ...CLI_HOST_RPC_HANDLERS,
        "echo.ok": async (params) => ({ echoed: params }),
        "echo.fail": () => {
          throw new Error("nope")
        },
      },
    })
    h.emit({ type: "host_rpc", rpcId: "a", method: "echo.ok", params: { x: 1 } })
    h.emit({ type: "host_rpc", rpcId: "b", method: "echo.fail", params: {} })
    await flush()
    await flush()
    // Replies are keyed by rpcId; a sync failure may be written before an async success.
    const byId = Object.fromEntries(h.parsedWrites().map((w) => [w.rpcId, w]))
    expect(byId).toEqual({
      a: { type: "host_rpc_result", rpcId: "a", ok: true, result: { echoed: { x: 1 } } },
      b: { type: "host_rpc_result", rpcId: "b", ok: false, error: "nope" },
    })
  })

  it("ignores a frame without an rpcId and does not reply after exit", async () => {
    const h = makeHandle()
    new StdioTransport(h.handle)
    h.emit({ type: "host_rpc", method: "workspace.portEnv" })
    await flush()
    h.exit(0)
    h.emit({ type: "host_rpc", rpcId: "late", method: "workspace.portEnv" })
    await flush()
    await flush()
    expect(h.writes).toEqual([])
  })
})
