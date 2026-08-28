/**
 * @jest-environment jsdom
 */
import {
  capabilitiesForCompanionReport,
  installCapabilityReporter,
  type CapabilityReporterTransport,
} from "./capability-reporter"
import type { ConnectionState } from "@/lib/tauri/transport-companion"

function makeTransport(initial: ConnectionState) {
  const handlers = new Set<(state: ConnectionState) => void>()
  let state = initial
  const call = jest.fn(async (_name: string, _args?: Record<string, unknown>) => null)
  const transport: CapabilityReporterTransport = {
    call,
    getConnectionState: () => state,
    onConnectionStateChange: (handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  }
  const setState = (next: ConnectionState) => {
    state = next
    for (const h of handlers) h(next)
  }
  return { transport, call, setState, handlers }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("installCapabilityReporter", () => {
  it("reports immediately when already connected", async () => {
    const { transport, call } = makeTransport("connected")
    const dispose = installCapabilityReporter(transport)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    const [name, args] = call.mock.calls[0]
    expect(name).toBe("device_capabilities_report")
    // jsdom → web baseline.
    expect(args).toEqual({ capabilities: ["webview"] })
    dispose()
  })

  it("waits for the connected transition when starting offline", async () => {
    const { transport, call, setState } = makeTransport("offline")
    const dispose = installCapabilityReporter(transport)
    await flush()
    expect(call).not.toHaveBeenCalled()
    setState("connected")
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("dedupes an unchanged manifest across reconnects", async () => {
    const { transport, call, setState } = makeTransport("connected")
    const dispose = installCapabilityReporter(transport)
    await flush()
    setState("reconnecting")
    setState("connected")
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    dispose()
  })

  it("retries on the next connect after a failed report", async () => {
    const { transport, call, setState } = makeTransport("connected")
    call.mockRejectedValueOnce(new Error("boom"))
    const dispose = installCapabilityReporter(transport)
    await flush()
    expect(call).toHaveBeenCalledTimes(1)
    // Failure must not poison the dedupe key — reconnect retries.
    setState("reconnecting")
    setState("connected")
    await flush()
    expect(call).toHaveBeenCalledTimes(2)
    dispose()
  })

  it("teardown unsubscribes from connection-state changes", async () => {
    const { transport, call, setState, handlers } = makeTransport("offline")
    const dispose = installCapabilityReporter(transport)
    dispose()
    expect(handlers.size).toBe(0)
    setState("connected")
    await flush()
    expect(call).not.toHaveBeenCalled()
  })
})

describe("capabilitiesForCompanionReport", () => {
  it("advertises thread handoff from a standalone phone only", () => {
    const capabilities = ["webview", "thread-handoff-v1"]
    expect(capabilitiesForCompanionReport(capabilities, "mobile", false)).toEqual(["webview"])
    expect(capabilitiesForCompanionReport(capabilities, "mobile", true)).toEqual(capabilities)
    expect(capabilitiesForCompanionReport(capabilities, "tauri", false)).toEqual(capabilities)
  })
})
