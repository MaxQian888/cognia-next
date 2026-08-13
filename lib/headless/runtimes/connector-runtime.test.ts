/**
 * Co-located headless smoke for the connector runtime (ADR-0059 T-A5): seam remapping
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
import {
  connectorsHttpRequest,
  connectorsMatrixCryptoClose,
  connectorsStopServer,
} from "@/lib/connectors/tauri/commands"
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
const mockHandleLarkOAuth = jest.fn()

jest.mock("@/lib/connectors/adapters/lark/oauth-handler", () => ({
  handleLarkOAuth: (...args: unknown[]) => mockHandleLarkOAuth(...args),
}))

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
    expect(opts.acquireRuntimeLock).toEqual(expect.any(Function))

    // The installer's log sink is the serve process logger.
    opts.log!("warn", "boot message")
    expect(ctx.logs).toContainEqual(["warn", "boot message"])

    await stop()
    expect(mockDispose).toHaveBeenCalledTimes(1)
  })

  it("holds and releases the server connector-runtime lease", async () => {
    mockCall.mockImplementation((name: string) =>
      Promise.resolve(name === "connectors_runtime_lease_acquire")
    )
    const { stop } = await bootConnectorRuntime()
    const acquire = mockInstall.mock.calls[0][0]!.acquireRuntimeLock!
    const controller = new AbortController()

    await expect(acquire(controller.signal)).resolves.toBe(true)
    expect(mockCall).toHaveBeenCalledWith("connectors_runtime_lease_acquire", {
      ownerId: expect.any(String),
      ttlMs: 15_000,
    })

    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mockCall).toHaveBeenCalledWith("connectors_runtime_lease_release", {
      ownerId: expect.any(String),
    })
    await stop()
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
    await connectorsMatrixCryptoClose("mx-headless")
    expect(mockCall).toHaveBeenCalledWith("connectors_matrix_crypto_close", {
      adapterId: "mx-headless",
    })
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

  it("completes Lark OAuth callbacks published by the headless front door", async () => {
    const handlers = new Map<string, (payload: unknown) => void>()
    mockSubscribe.mockImplementation((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    })
    mockHandleLarkOAuth.mockResolvedValue({ openId: "ou-1" })
    mockCall.mockImplementation((name: string) =>
      Promise.resolve(name === "connectors_runtime_lease_acquire")
    )

    const { ctx, stop } = await bootConnectorRuntime()
    const controller = new AbortController()
    await mockInstall.mock.calls[0][0]!.acquireRuntimeLock!(controller.signal)
    expect(handlers.has("connectors://lark-oauth/callback")).toBe(true)

    handlers.get("connectors://lark-oauth/callback")!({
      code: "code-1",
      state: "lark:lk-1:nonce",
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mockHandleLarkOAuth).toHaveBeenCalledWith("code-1", {
      state: "lark:lk-1:nonce",
    })
    expect(ctx.logs).toContainEqual(["info", "[connector-bus] Lark OAuth completed"])

    controller.abort()
    await stop()
    expect(handlers.has("connectors://lark-oauth/callback")).toBe(false)
  })

  it("teardown restores the default Tauri seams", async () => {
    const { stop } = await bootConnectorRuntime()
    // Boot registers the brain-side Lark intent bridge over the headless
    // seam (plan 2026-07-24 P3) — the one subscribe expected before stop.
    expect(mockSubscribe).toHaveBeenCalledWith("connectors://lark-intent", expect.any(Function))
    await stop()
    mockSubscribe.mockClear()

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
