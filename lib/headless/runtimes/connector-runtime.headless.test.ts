/**
 * Headless smoke for the connector runtime (ADR-0059 T-A5): seam remapping
 * onto the companion transport (RPC name mapping, host no-ops, event
 * envelope), boot options (webhook-only row filter, skipHostGate, ctx.log),
 * and teardown restoring the Tauri seams.
 *
 * @jest-environment node
 */

import { invoke } from "@tauri-apps/api/core"
import { listen as tauriListen } from "@tauri-apps/api/event"
import { transport } from "@/lib/tauri"
import { bootstrapHeadlessRuntimes } from "../bootstrap"
import { __resetHeadlessRuntimesForTesting } from "../registry"
import type { HeadlessRuntimeContext, RuntimeBridge } from "../types"
import { installConnectorRuntime } from "@/lib/connectors/bootstrap/install-connector-runtime"
import { connectorsHttpRequest, connectorsStopServer } from "@/lib/connectors/tauri/commands"
import { connectorListen } from "@/lib/connectors/events"

// The full connector bootstrap is covered by its own suite — here it is a
// seam so this suite can assert the options the runtime passes it.
const mockDispose = jest.fn()
jest.mock("@/lib/connectors/bootstrap/install-connector-runtime", () => ({
  installConnectorRuntime: jest.fn(() => mockDispose),
}))
const mockInstall = installConnectorRuntime as jest.MockedFunction<typeof installConnectorRuntime>

// Companion transport seam (live binding read per-call by the runtime).
jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn(), subscribe: jest.fn() },
  isTauri: jest.fn(() => false),
}))
const mockCall = transport.call as jest.Mock
const mockSubscribe = transport.subscribe as jest.Mock
const mockTauriInvoke = invoke as jest.Mock

const makeBridge = (): RuntimeBridge => ({
  listen: async () => () => undefined,
  invoke: async () => null,
})

const makeCtx = (): HeadlessRuntimeContext & { logs: Array<[string, string]> } => {
  const logs: Array<[string, string]> = []
  return {
    host: "brain",
    accountId: "local_acct_a",
    bridge: makeBridge(),
    notifyDbWrite: () => undefined,
    resolveMessage: (key) => key,
    log: (level, message) => logs.push([level, message]),
    logs,
  }
}

const bootConnectorRuntime = async () => {
  const ctx = makeCtx()
  const result = await bootstrapHeadlessRuntimes(ctx)
  expect(result.failed).toEqual([])
  expect(result.started).toContain("connector-runtime")
  return { ctx, stop: result.stop }
}

beforeAll(async () => {
  // Registration happens at module-evaluation time (once per Jest module
  // registry) — reset the roster first so this suite owns exactly one entry.
  __resetHeadlessRuntimesForTesting()
  await import("./connector-runtime")
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe("connector-runtime (headless)", () => {
  it("boots every connector transport through the shared headless command and event seams", async () => {
    const { ctx, stop } = await bootConnectorRuntime()

    expect(mockInstall).toHaveBeenCalledTimes(1)
    const opts = mockInstall.mock.calls[0][0]!
    expect(opts.skipHostGate).toBe(true)
    expect(opts.rowFilter).toBeUndefined()

    // The installer's log sink is the serve process logger.
    opts.log!("warn", "boot message")
    expect(ctx.logs).toContainEqual(["warn", "boot message"])

    await stop()
    expect(mockDispose).toHaveBeenCalledTimes(1)
  })

  it("maps the legacy register/unregister arm names with snake_case params", async () => {
    const { stop } = await bootConnectorRuntime()
    mockCall.mockResolvedValue(null)

    const { connectorsRegisterAdapter, connectorsUnregisterAdapter } =
      await import("@/lib/connectors/tauri/commands")
    await connectorsRegisterAdapter({ adapterId: "tg-1", adapterType: "telegram" })
    expect(mockCall).toHaveBeenCalledWith("connectors_register", {
      adapter_id: "tg-1",
      adapter_type: "telegram",
    })

    await connectorsUnregisterAdapter("tg-1")
    expect(mockCall).toHaveBeenCalledWith("connectors_unregister", { adapter_id: "tg-1" })

    expect(mockTauriInvoke).not.toHaveBeenCalled()
    await stop()
  })

  it("keeps server lifecycle local but resets server-owned sockets over RPC", async () => {
    const { stop } = await bootConnectorRuntime()
    mockCall.mockResolvedValue(3)

    const { connectorsStartServer, connectorsResetAllWs } =
      await import("@/lib/connectors/tauri/commands")
    await expect(connectorsStartServer(7842, true)).resolves.toBe("companion:/connectors")
    await expect(connectorsStopServer()).resolves.toBeUndefined()
    await expect(connectorsResetAllWs()).resolves.toBe(3)

    expect(mockCall).toHaveBeenCalledWith("connectors_reset_all_ws", undefined)
    expect(mockTauriInvoke).not.toHaveBeenCalled()
    await stop()
  })

  it("passes every other command through same-name with args verbatim", async () => {
    const { stop } = await bootConnectorRuntime()
    const response = { status: 200, headers: {}, body: "{}" }
    mockCall.mockResolvedValue(response)

    const req = { url: "https://api.telegram.org/botX/sendMessage", method: "POST" }
    await expect(connectorsHttpRequest(req)).resolves.toEqual(response)
    expect(mockCall).toHaveBeenCalledWith("connectors_http_request", { req })
    expect(mockTauriInvoke).not.toHaveBeenCalled()
    await stop()
  })

  it("routes webhook listens over transport.subscribe with the Tauri envelope", async () => {
    const { stop } = await bootConnectorRuntime()
    const unsubscribe = jest.fn()
    let pushPayload: ((payload: unknown) => void) | null = null
    mockSubscribe.mockImplementation((_event: string, handler: (payload: unknown) => void) => {
      pushPayload = handler
      return unsubscribe
    })

    const seen: unknown[] = []
    const unlisten = await connectorListen("connectors://webhook/tg-1", (event) =>
      seen.push(event.payload)
    )
    expect(mockSubscribe).toHaveBeenCalledWith("connectors://webhook/tg-1", expect.any(Function))

    // The raw `/ws/v1/events` frame payload arrives wrapped as `{ payload }`
    // — the exact envelope the transports read from Tauri events.
    pushPayload!({ update_id: 7 })
    expect(seen).toEqual([{ update_id: 7 }])

    unlisten()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    await stop()
  })

  it("teardown restores the default Tauri seams", async () => {
    const { stop } = await bootConnectorRuntime()
    await stop()

    // Commands route back to Tauri invoke...
    mockTauriInvoke.mockResolvedValue(undefined)
    await connectorsStopServer()
    expect(mockTauriInvoke).toHaveBeenCalledWith("connectors_stop_server")
    expect(mockCall).not.toHaveBeenCalled()

    // ...and listens back to Tauri listen (mocked module → no subscribe).
    const listenMock = tauriListen as jest.Mock
    listenMock.mockResolvedValue(() => undefined)
    await connectorListen("connectors://webhook/tg-1", () => undefined)
    expect(listenMock).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).not.toHaveBeenCalled()
  })
})
