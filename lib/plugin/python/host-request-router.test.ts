import type { PluginContext } from "@/types/plugin/plugin"

import {
  routePythonHostRequest,
  unpackHostCallArgs,
  type PythonHostRequestFrame,
} from "./host-request-router"

function frame(method: string, params: unknown = {}): PythonHostRequestFrame {
  return { pluginId: "demo", generation: "gen-1", requestId: 1, method, params }
}

function contextWith(shape: Record<string, unknown>): PluginContext {
  return shape as unknown as PluginContext
}

describe("unpackHostCallArgs", () => {
  it("treats a lone args array as positional arguments", () => {
    expect(unpackHostCallArgs({ args: ["a", 2] })).toEqual(["a", 2])
  })

  it("passes a keyword object through as one argument", () => {
    expect(unpackHostCallArgs({ prompt: "hi" })).toEqual([{ prompt: "hi" }])
  })

  it("keeps a mixed call as a single object rather than guessing", () => {
    // host.py packs f(a, b=1) as {args:[a], b:1}; splitting that back into
    // positional+keyword would invent an ordering the wire never carried.
    expect(unpackHostCallArgs({ args: ["a"], b: 1 })).toEqual([{ args: ["a"], b: 1 }])
  })

  it("treats an object whose only key is a non-array args as keywords", () => {
    expect(unpackHostCallArgs({ args: "not-an-array" })).toEqual([{ args: "not-an-array" }])
  })

  it("returns no arguments for empty params", () => {
    expect(unpackHostCallArgs({})).toEqual([])
    expect(unpackHostCallArgs(null)).toEqual([])
    expect(unpackHostCallArgs(undefined)).toEqual([])
  })
})

describe("routePythonHostRequest", () => {
  it("invokes a namespaced method and returns its result", async () => {
    const run = jest.fn().mockResolvedValue({ text: "ok" })
    const outcome = await routePythonHostRequest(frame("agent.run", { prompt: "hi" }), {
      getContext: () => contextWith({ agent: { run } }),
    })
    expect(outcome).toEqual({ ok: true, result: { text: "ok" } })
    expect(run).toHaveBeenCalledWith({ prompt: "hi" })
  })

  it("resolves nested namespaces so ctx.agent.sessions is reachable", async () => {
    const send = jest.fn().mockResolvedValue("sent")
    const outcome = await routePythonHostRequest(frame("agent.sessions.send", { args: ["x"] }), {
      getContext: () => contextWith({ agent: { sessions: { send } } }),
    })
    expect(outcome).toEqual({ ok: true, result: "sent" })
    expect(send).toHaveBeenCalledWith("x")
  })

  it("round-trips ctx.commands.listSlashCommands now the namespace is open to python", async () => {
    // ADR-0164 deferred this route. The router needed no per-namespace
    // branch: opening `commands` to python in the catalog is what made the
    // SDK emit the frame, and the generic dotted resolution answers it.
    const listSlashCommands = jest
      .fn()
      .mockResolvedValue([{ id: "py.hello", name: "Hello", source: "plugin" }])
    const outcome = await routePythonHostRequest(frame("commands.listSlashCommands", {}), {
      getContext: () => contextWith({ commands: { listSlashCommands } }),
    })
    expect(outcome).toEqual({
      ok: true,
      result: [{ id: "py.hello", name: "Hello", source: "plugin" }],
    })
    expect(listSlashCommands).toHaveBeenCalledWith()
  })

  it("preserves the namespace as `this` so guarded APIs keep their closure", async () => {
    const namespace = {
      secret: "kept",
      read(this: { secret: string }) {
        return this.secret
      },
    }
    const outcome = await routePythonHostRequest(frame("storage.read"), {
      getContext: () => contextWith({ storage: namespace }),
    })
    expect(outcome).toEqual({ ok: true, result: "kept" })
  })

  it("reports a permission denial from the guarded API as an error value", async () => {
    // The guarded API throws; the plugin must receive that as an answer, not
    // as silence it would sit on until its own timeout.
    const outcome = await routePythonHostRequest(frame("fs.readText", { args: ["/etc/passwd"] }), {
      getContext: () =>
        contextWith({
          fs: {
            readText: () => {
              throw new Error("Permission denied: filesystem:read is required")
            },
          },
        }),
    })
    expect(outcome).toEqual({
      ok: false,
      error: "Permission denied: filesystem:read is required",
    })
  })

  it("refuses a method path that is not namespaced", async () => {
    const outcome = await routePythonHostRequest(frame("run"), {
      getContext: () => contextWith({ run: () => "nope" }),
    })
    expect(outcome).toEqual({
      ok: false,
      error: "invalid host call 'run': expected '<namespace>.<method>'",
    })
  })

  it.each(["__proto__.polluted", "agent.constructor", "agent._private", "_agent.run"])(
    "refuses the private or prototype path %s",
    async (method) => {
      const outcome = await routePythonHostRequest(frame(method), {
        getContext: () => contextWith({ agent: { run: () => "x" } }),
      })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.error).toContain("private path")
    }
  )

  it("refuses when the plugin has no active context", async () => {
    const outcome = await routePythonHostRequest(frame("agent.run"), { getContext: () => null })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain("no active context")
  })

  it("reports an unknown namespace and an unknown method distinctly", async () => {
    const missingNamespace = await routePythonHostRequest(frame("ghost.run"), {
      getContext: () => contextWith({ agent: {} }),
    })
    expect(missingNamespace.ok).toBe(false)
    if (!missingNamespace.ok) expect(missingNamespace.error).toContain("'ghost' is not available")

    const missingMethod = await routePythonHostRequest(frame("agent.ghost"), {
      getContext: () => contextWith({ agent: {} }),
    })
    expect(missingMethod.ok).toBe(false)
    if (!missingMethod.ok) expect(missingMethod.error).toContain("is not a function")
  })

  it("normalizes undefined to null because the wire has no undefined", async () => {
    const outcome = await routePythonHostRequest(frame("ui.showToast"), {
      getContext: () => contextWith({ ui: { showToast: () => undefined } }),
    })
    expect(outcome).toEqual({ ok: true, result: null })
  })

  it("errors on a non-serializable result instead of shipping an empty object", async () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const outcome = await routePythonHostRequest(frame("storage.get"), {
      getContext: () => contextWith({ storage: { get: () => cyclic } }),
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain("not JSON-serializable")
  })
})
