/**
 * @jest-environment jsdom
 */

import { renderHook, waitFor, act } from "@testing-library/react"

import type { Transport } from "@/lib/tauri/transport-types"

type ConnectionState = "connected" | "reconnecting" | "offline" | "unauthenticated"

interface StatefulTransport extends Transport {
  getConnectionState(): ConnectionState
  onConnectionStateChange(cb: (state: ConnectionState) => void): () => void
  emit(state: ConnectionState): void
  listenerCount(): number
}

function makeStatefulTransport(initial: ConnectionState): StatefulTransport {
  let state = initial
  const listeners = new Set<(s: ConnectionState) => void>()
  return {
    call: jest.fn(),
    subscribe: jest.fn(() => () => {}),
    getConnectionState: () => state,
    onConnectionStateChange(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit(next) {
      state = next
      for (const cb of listeners) cb(next)
    },
    listenerCount: () => listeners.size,
  } as StatefulTransport
}

/** A transport with no connection-state semantics — the plain web stub. */
function makeStubTransport(): Transport {
  return { call: jest.fn(), subscribe: jest.fn(() => () => {}) }
}

let current: Transport
const swapHandlers = new Set<() => void>()

jest.mock("@/lib/tauri/transport-instance", () => ({
  get transport() {
    return current
  },
  onTransportChange: (handler: () => void) => {
    swapHandlers.add(handler)
    return () => swapHandlers.delete(handler)
  },
}))

function swapTo(next: Transport) {
  current = next
  for (const handler of swapHandlers) handler()
}

import { useConnectionState } from "./use-connection-state"

beforeEach(() => {
  swapHandlers.clear()
  current = makeStubTransport()
})

describe("useConnectionState", () => {
  it("reports null on a transport with no connection-state semantics", async () => {
    const { result } = renderHook(() => useConnectionState())
    await waitFor(() => expect(swapHandlers.size).toBe(1))
    expect(result.current).toBeNull()
  })

  it("reports the current state and follows transitions", async () => {
    const t = makeStatefulTransport("reconnecting")
    current = t
    const { result } = renderHook(() => useConnectionState())

    await waitFor(() => expect(result.current).toBe("reconnecting"))
    act(() => t.emit("connected"))
    expect(result.current).toBe("connected")
  })

  it("re-binds when the singleton is replaced, instead of listening to the destroyed one", async () => {
    // The real sequence: a browser boots on the stub, pairing installs a
    // CompanionTransport, and `setTransport` destroys the stub — whose teardown
    // broadcasts `offline`. Bound once at mount, this hook reported "Offline"
    // for the rest of the session over a fully connected Host.
    const stub = makeStatefulTransport("offline")
    current = stub
    const { result } = renderHook(() => useConnectionState())
    await waitFor(() => expect(result.current).toBe("offline"))

    const live = makeStatefulTransport("connected")
    act(() => swapTo(live))

    await waitFor(() => expect(result.current).toBe("connected"))

    // The old instance's dying broadcast must not reach us any more.
    act(() => stub.emit("offline"))
    expect(result.current).toBe("connected")
    expect(stub.listenerCount()).toBe(0)
  })

  it("drops to null when the replacement has no connection-state semantics", async () => {
    const live = makeStatefulTransport("connected")
    current = live
    const { result } = renderHook(() => useConnectionState())
    await waitFor(() => expect(result.current).toBe("connected"))

    act(() => swapTo(makeStubTransport()))

    // Keeping "connected" here would be the previous instance's claim about a
    // Host this one cannot even describe.
    await waitFor(() => expect(result.current).toBeNull())
  })

  it("detaches from both the transport and the swap notifier on unmount", async () => {
    const live = makeStatefulTransport("connected")
    current = live
    const { unmount, result } = renderHook(() => useConnectionState())
    await waitFor(() => expect(result.current).toBe("connected"))
    expect(live.listenerCount()).toBe(1)

    unmount()

    expect(live.listenerCount()).toBe(0)
    expect(swapHandlers.size).toBe(0)
  })
})
