/**
 * Tests for the Discord Interactions Webhook transport. The Rust route has
 * already verified the signature and answered PING/ACK; this transport just
 * projects the emitted interaction into the ConnectorBus callback pipeline.
 */

import { listen } from "@tauri-apps/api/event"
import { getBus } from "@/lib/connectors/bus"
import { startWebhookTransport } from "./transport-webhook"

jest.mock("@tauri-apps/api/event", () => ({ listen: jest.fn() }))
jest.mock("@/lib/connectors/bus", () => {
  const dispatchConnectorCallback = jest.fn(async () => {})
  return { getBus: () => ({ dispatchConnectorCallback }) }
})

const mockListen = listen as jest.Mock
const busDispatch = (getBus() as unknown as { dispatchConnectorCallback: jest.Mock })
  .dispatchConnectorCallback

function makeListen() {
  let handler: (e: { payload: unknown }) => void = () => {}
  const unlisten = jest.fn()
  mockListen.mockImplementation(async (_name: string, h: (e: { payload: unknown }) => void) => {
    handler = h
    return unlisten
  })
  return { emit: (payload: unknown) => handler({ payload }), unlisten }
}

const componentInteraction = {
  type: 3,
  id: "i1",
  token: "tok",
  channel_id: "c1",
  member: { user: { id: "u1", username: "U" } },
  data: { custom_id: "a2ui:s:c:go", component_type: 2 },
}

beforeEach(() => {
  mockListen.mockReset()
  busDispatch.mockClear()
})

describe("startWebhookTransport", () => {
  it("subscribes to the adapter's webhook channel", async () => {
    makeListen()
    const ctrl = new AbortController()
    await startWebhookTransport({ adapterId: "dc-1", selfId: "self", signal: ctrl.signal })
    expect(mockListen).toHaveBeenCalledWith("connectors://webhook/dc-1", expect.any(Function))
  })

  it("dispatches a component interaction as a connector callback", async () => {
    const bridge = makeListen()
    const ctrl = new AbortController()
    await startWebhookTransport({ adapterId: "dc-1", selfId: "self", signal: ctrl.signal })
    bridge.emit(componentInteraction)
    await Promise.resolve()
    expect(busDispatch).toHaveBeenCalledTimes(1)
  })

  it("ignores non-interaction and non-object payloads", async () => {
    const bridge = makeListen()
    const ctrl = new AbortController()
    await startWebhookTransport({ adapterId: "dc-1", selfId: "self", signal: ctrl.signal })
    bridge.emit("not-an-object")
    bridge.emit({ type: 2, id: "i2", token: "t", channel_id: "c1", data: {} }) // command → parse returns null
    await Promise.resolve()
    expect(busDispatch).not.toHaveBeenCalled()
  })

  it("unlistens on stop() and on abort", async () => {
    const bridge = makeListen()
    const ctrl = new AbortController()
    const handle = await startWebhookTransport({
      adapterId: "dc-1",
      selfId: "self",
      signal: ctrl.signal,
    })
    handle.stop()
    expect(bridge.unlisten).toHaveBeenCalledTimes(1)
  })

  it("aborting the signal unlistens the subscription", async () => {
    const bridge = makeListen()
    const ctrl = new AbortController()
    await startWebhookTransport({ adapterId: "dc-1", selfId: "self", signal: ctrl.signal })
    ctrl.abort()
    expect(bridge.unlisten).toHaveBeenCalledTimes(1)
  })
})
