/**
 * @jest-environment node
 */
import { createBackendLifecycle } from "./backend-lifecycle"

interface Conn {
  agentId: string
}

/** A connect whose settlement the test controls. */
function deferredConnects() {
  const pending: { attempt: number; settle: (c: Conn | null) => void }[] = []
  const disconnected: string[] = []
  const connect = (attempt: number) =>
    new Promise<Conn | null>((resolve) => {
      pending.push({ attempt, settle: resolve })
    })
  const disconnect = async (connection: Conn) => {
    disconnected.push(connection.agentId)
  }
  const settle = (index: number, agentId: string | null) => {
    pending[index].settle(agentId ? { agentId } : null)
  }
  return { connect, disconnect, disconnected, pending, settle }
}

const flush = () => new Promise((r) => setImmediate(r))

describe("createBackendLifecycle", () => {
  it("installs the connection when the attempt is still current", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const started = lifecycle.start()
    d.settle(0, "agent-1")
    expect(await started).toEqual({ agentId: "agent-1" })
    expect(lifecycle.current()).toEqual({ agentId: "agent-1" })
    expect(d.disconnected).toEqual([])
  })

  it("reclaims — not merely ignores — a process that registers after a cancel", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const started = lifecycle.start()
    lifecycle.cancel()
    d.settle(0, "agent-late")
    expect(await started).toBeNull()
    expect(lifecycle.current()).toBeNull()
    // The old code left this process registered forever.
    expect(d.disconnected).toEqual(["agent-late"])
  })

  it("reclaims a process that registers after dispose", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const started = lifecycle.start()
    const disposing = lifecycle.dispose()
    d.settle(0, "agent-late")
    expect(await started).toBeNull()
    await disposing
    expect(d.disconnected).toEqual(["agent-late"])
  })

  it("survives two rapid backend switches with one live process at the end", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const first = lifecycle.start()
    const second = lifecycle.start()
    d.settle(0, "agent-1")
    d.settle(1, "agent-2")
    expect(await first).toBeNull()
    expect(await second).toEqual({ agentId: "agent-2" })
    expect(d.disconnected).toEqual(["agent-1"])
    expect(lifecycle.current()).toEqual({ agentId: "agent-2" })
  })

  it("reclaims the previous connection when a new attempt starts", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const first = lifecycle.start()
    d.settle(0, "agent-1")
    await first
    const second = lifecycle.start()
    await flush()
    d.settle(1, "agent-2")
    await second
    expect(d.disconnected).toEqual(["agent-1"])
  })

  it("leaves an already-installed connection alone — reaching one IS success", async () => {
    // The connect effect's cleanup runs on the very transition that a successful
    // connect causes (connecting → chat). Reclaiming there would kill the agent
    // the user just started.
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const started = lifecycle.start()
    d.settle(0, "agent-1")
    await started
    lifecycle.cancel()
    await flush()
    expect(lifecycle.current()).toEqual({ agentId: "agent-1" })
    expect(d.disconnected).toEqual([])
  })

  it("still reclaims that connection on dispose", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const started = lifecycle.start()
    d.settle(0, "agent-1")
    await started
    lifecycle.cancel()
    await lifecycle.dispose()
    expect(d.disconnected).toEqual(["agent-1"])
  })

  it("closes the session BEFORE reclaiming the process", async () => {
    const order: string[] = []
    const lifecycle = createBackendLifecycle<Conn>({
      connect: async () => ({ agentId: "agent-1" }),
      disconnect: async () => {
        order.push("disconnect")
      },
      closeSession: async () => {
        order.push("closeSession")
      },
    })
    await lifecycle.start()
    await lifecycle.dispose()
    // A bridge must never be able to run a tool against a session whose process
    // has already gone.
    expect(order).toEqual(["closeSession", "disconnect"])
  })

  it("is safe to dispose twice", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const started = lifecycle.start()
    d.settle(0, "agent-1")
    await started
    await lifecycle.dispose()
    await lifecycle.dispose()
    expect(d.disconnected).toEqual(["agent-1"])
    expect(lifecycle.isDisposed()).toBe(true)
  })

  it("refuses to start after dispose", async () => {
    const lifecycle = createBackendLifecycle<Conn>({
      connect: async () => ({ agentId: "agent-1" }),
      disconnect: async () => undefined,
    })
    await lifecycle.dispose()
    expect(await lifecycle.start()).toBeNull()
  })

  it("is safe to cancel before anything started, and to cancel twice", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    expect(() => lifecycle.cancel()).not.toThrow()
    expect(() => lifecycle.cancel()).not.toThrow()
    expect(d.disconnected).toEqual([])
  })

  it("treats a failed connect as no connection, without a stray reclaim", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    const started = lifecycle.start()
    d.settle(0, null)
    expect(await started).toBeNull()
    expect(lifecycle.current()).toBeNull()
    expect(d.disconnected).toEqual([])
  })

  it("treats a thrown connect as a failure rather than propagating it", async () => {
    const lifecycle = createBackendLifecycle<Conn>({
      connect: async () => {
        throw new Error("spawn ENOENT")
      },
      disconnect: async () => undefined,
    })
    await expect(lifecycle.start()).resolves.toBeNull()
  })

  it("still reclaims the process when closeSession throws", async () => {
    const disconnected: string[] = []
    const lifecycle = createBackendLifecycle<Conn>({
      connect: async () => ({ agentId: "agent-1" }),
      disconnect: async (c) => {
        disconnected.push(c.agentId)
      },
      closeSession: async () => {
        throw new Error("broker close failed")
      },
    })
    await lifecycle.start()
    await lifecycle.dispose()
    expect(disconnected).toEqual(["agent-1"])
  })

  it("swallows a disconnect failure so teardown always completes", async () => {
    const lifecycle = createBackendLifecycle<Conn>({
      connect: async () => ({ agentId: "agent-1" }),
      disconnect: async () => {
        throw new Error("already gone")
      },
    })
    await lifecycle.start()
    await expect(lifecycle.dispose()).resolves.toBeUndefined()
  })

  it("waits out a settling connect before dispose resolves", async () => {
    const d = deferredConnects()
    const lifecycle = createBackendLifecycle<Conn>(d)
    void lifecycle.start()
    let disposed = false
    const disposing = lifecycle.dispose().then(() => {
      disposed = true
    })
    await flush()
    expect(disposed).toBe(false)
    d.settle(0, "agent-late")
    await disposing
    // Every spawn has exactly one terminal remove record.
    expect(d.disconnected).toEqual(["agent-late"])
  })
})
