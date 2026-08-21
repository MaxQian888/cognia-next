import {
  getRemoteWorkerRuntime,
  __resetRemoteWorkerRuntimeForTesting,
} from "./remote-worker-runtime"
import { attachTauriWorkerRuntime, type WorkerBrainEnvelope } from "./tauri-worker-runtime"

jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(),
  Channel: class {
    onmessage: ((message: unknown) => void) | undefined
  },
}))

const manifest = {
  manifestVersion: 1,
  runtime: "test",
  models: [],
  hardCapabilities: [],
  maxActiveTurns: 1,
  credentialProfileRefs: [],
  workspaceBindingRefs: [],
  taskWorkspace: { enabled: true },
  sandbox: { capabilities: [] },
  platform: { os: "test", arch: "test" },
  executionProfile: {
    profileVersion: 1,
    backendId: "test",
    runtimeAdapter: "external",
    modelBindings: { primary: "inherit" },
    deploymentRefs: ["provider:test"],
    capabilities: [],
  },
}

class FakeChannel {
  onmessage: ((message: WorkerBrainEnvelope) => void) | undefined
  deliver(envelope: WorkerBrainEnvelope) {
    this.onmessage?.(envelope)
  }
}

function setup(invoke = jest.fn(async () => undefined)) {
  const channel = new FakeChannel()
  return {
    invoke,
    channel,
    attach: () =>
      attachTauriWorkerRuntime({
        tenantId: "local_acct_a",
        invoke: invoke as never,
        createChannel: () => channel as never,
      }),
  }
}

describe("attachTauriWorkerRuntime", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    __resetRemoteWorkerRuntimeForTesting()
  })

  afterEach(() => {
    jest.useRealTimers()
    __resetRemoteWorkerRuntimeForTesting()
  })

  it("installs the runtime so dispatch stops being a no-op on this host", async () => {
    // The whole defect this fixes: `getRemoteWorkerRuntime()` returned
    // undefined on desktop, so every placement decision resolved to "no runtime"
    // while Fleet still reported the worker online.
    const harness = setup()
    expect(getRemoteWorkerRuntime()).toBeUndefined()

    const handle = await harness.attach()

    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_attach_channel", {
      tenantId: "local_acct_a",
      onEvent: harness.channel,
    })
    expect(getRemoteWorkerRuntime()).toBe(handle.pool)
  })

  it("routes attach, frame, and detach envelopes into the pool", async () => {
    const harness = setup()
    const handle = await harness.attach()

    harness.channel.deliver({
      seq: 1,
      type: "worker_attach",
      connectionId: "connection-1",
      hostRef: "device:a",
      manifest,
    })
    expect(handle.pool.listWorkers()).toEqual([
      expect.objectContaining({ hostRef: "device:a", online: true }),
    ])

    harness.channel.deliver({
      seq: 2,
      type: "worker_frame",
      connectionId: "connection-1",
      frame: '{"jsonrpc":"2.0","id":1,"result":{}}',
    })
    expect(handle.pool.listWorkers()).toHaveLength(1)

    harness.channel.deliver({
      seq: 3,
      type: "worker_detach",
      connectionId: "connection-1",
      hostRef: "device:a",
      reason: "socket_closed",
    })
    expect(handle.pool.listWorkers()).toEqual([])
  })

  it("acks cumulatively on a timer instead of once per frame", async () => {
    // Acks release the host's inbound byte budget. They are cumulative, so
    // coalescing is free — and one invoke per frame would double IPC traffic on
    // the hot path.
    const harness = setup()
    await harness.attach()
    harness.invoke.mockClear()

    harness.channel.deliver({
      seq: 7,
      type: "worker_frame",
      connectionId: "unknown",
      frame: "ignored",
    })
    harness.channel.deliver({
      seq: 8,
      type: "worker_frame",
      connectionId: "unknown",
      frame: "ignored",
    })
    expect(harness.invoke).not.toHaveBeenCalled()

    jest.advanceTimersByTime(50)

    expect(harness.invoke).toHaveBeenCalledTimes(1)
    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_ack_events", { throughSeq: 8 })
  })

  it("retries an ack the host refused instead of dropping the window", async () => {
    // A failed ack means those bytes are still charged against the host's
    // inbound budget. Dropping the window would only be repaired by the NEXT
    // envelope — and between turns none arrives, so the budget would stay held
    // and a later frame would trip the backpressure timeout on a healthy
    // connection.
    let failAck = true
    const invoke = jest.fn(async (command: string) => {
      if (command === "companion_worker_ack_events" && failAck) {
        throw new Error("no desktop brain is attached")
      }
      return undefined
    })
    const harness = setup(invoke as never)
    await harness.attach()
    harness.invoke.mockClear()

    harness.channel.deliver({
      seq: 4,
      type: "worker_frame",
      connectionId: "unknown",
      frame: "ignored",
    })

    jest.advanceTimersByTime(50)
    await Promise.resolve()
    await Promise.resolve()
    expect(harness.invoke).toHaveBeenCalledTimes(1)

    // The discriminating assertion: NO new envelope arrives, so the only thing
    // that can produce a second ack is the retry re-arming the timer itself.
    failAck = false
    jest.advanceTimersByTime(50)
    await Promise.resolve()

    expect(harness.invoke).toHaveBeenCalledTimes(2)
    expect(harness.invoke).toHaveBeenLastCalledWith("companion_worker_ack_events", {
      throughSeq: 4,
    })
  })

  it("flushes an ack immediately once the batch window fills", async () => {
    const harness = setup()
    await harness.attach()
    harness.invoke.mockClear()

    for (let seq = 1; seq <= 32; seq += 1) {
      harness.channel.deliver({
        seq,
        type: "worker_frame",
        connectionId: "unknown",
        frame: "ignored",
      })
    }

    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_ack_events", { throughSeq: 32 })
  })

  it("sends outbound frames in order through one serialized invoke chain", async () => {
    // Separate `invoke` calls carry no ordering guarantee, and Agent RPC breaks
    // if a response overtakes the request it answers.
    const order: string[] = []
    const invoke = jest.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "companion_worker_send_frame") order.push(String(args?.frame))
      return undefined
    })
    const harness = setup(invoke as never)
    const handle = await harness.attach()
    harness.channel.deliver({
      seq: 1,
      type: "worker_attach",
      connectionId: "connection-1",
      hostRef: "device:a",
      manifest,
    })

    const worker = handle.pool.listWorkers()[0]
    expect(worker).toBeDefined()
    const sink = (
      handle.pool as unknown as {
        workers: Map<string, { writable: { write(chunk: string): boolean } }>
      }
    ).workers.get("connection-1")!.writable
    sink.write('{"id":1}\n{"id":2}\n')
    sink.write('{"id":3}\n')

    await jest.advanceTimersByTimeAsync(0)
    // The real SDK client boots over this transport, so its `initialize` is the
    // first thing on the wire — evidence the whole Agent RPC stack now runs in
    // the WebView, not just that our own writes are ordered.
    expect(JSON.parse(order[0]!)).toMatchObject({ method: "initialize" })
    expect(order.slice(1)).toEqual(['{"id":1}', '{"id":2}', '{"id":3}'])
  })

  it("detaches the connection when a frame never reaches the worker", async () => {
    // A dropped frame strands every in-flight call on that connection. Closing
    // it surfaces the break to the dispatcher, which already recovers from a
    // closed worker.
    const invoke = jest.fn(async (command: string) => {
      if (command === "companion_worker_send_frame")
        throw new Error("worker connection is unavailable")
      return undefined
    })
    const harness = setup(invoke as never)
    const handle = await harness.attach()
    harness.channel.deliver({
      seq: 1,
      type: "worker_attach",
      connectionId: "connection-1",
      hostRef: "device:a",
      manifest,
    })

    const sink = (
      handle.pool as unknown as {
        workers: Map<string, { writable: { write(chunk: string): boolean } }>
      }
    ).workers.get("connection-1")!.writable
    sink.write('{"id":1}\n')
    await jest.advanceTimersByTimeAsync(0)

    expect(handle.pool.listWorkers()).toEqual([])
  })

  it("releases the runtime slot and the host channel on dispose", async () => {
    const harness = setup()
    const handle = await harness.attach()

    await handle.dispose()

    expect(getRemoteWorkerRuntime()).toBeUndefined()
    expect(harness.invoke).toHaveBeenCalledWith("companion_worker_detach_channel", {})
  })
})
