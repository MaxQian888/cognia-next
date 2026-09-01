/**
 * @jest-environment jsdom
 *
 * Pins the two things this helper decides: that a shell without the hardware
 * says so instead of failing, and that a connected port is registered in all
 * three places the dock reads from. Missing any one of them is the
 * built-but-unreachable shape this repo keeps producing.
 */

const registerLiveSessionMock = jest.fn()
jest.mock("./session-registry", () => ({
  registerLiveSession: (...args: unknown[]) => registerLiveSessionMock(...args),
}))

const wireSessionToStoreMock = jest.fn()
jest.mock("./spawn-orchestrator", () => ({
  wireSessionToStore: (...args: unknown[]) => wireSessionToStoreMock(...args),
}))

const dispatchTerminalLifecycleMock = jest.fn()
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchTerminalLifecycle: (...args: unknown[]) => dispatchTerminalLifecycleMock(...args),
  }),
}))

import { connectSerialFromDock } from "./serial-connect"
import { DEFAULT_SERIAL_CONFIG } from "./serial/types"
import type { SerialTerminalSession } from "./serial-session"

const config = { ...DEFAULT_SERIAL_CONFIG, port: "/dev/cu.usbserial-1420" }

function store() {
  return {
    registerSession: jest.fn(),
    removeSession: jest.fn(),
    setSessionStatus: jest.fn(),
    setSessionExit: jest.fn(),
    setSessionCwd: jest.fn(),
  } as unknown as Parameters<typeof connectSerialFromDock>[0]["store"] & {
    registerSession: jest.Mock
  }
}

function fakeSession(id = "sess-1") {
  return {
    info: { id, projectId: "proj-a", extensionId: null, origin: "user", shell: "port" },
  } as unknown as SerialTerminalSession
}

beforeEach(() => {
  registerLiveSessionMock.mockReset()
  wireSessionToStoreMock.mockReset()
  dispatchTerminalLifecycleMock.mockReset()
})

/**
 * A companion shell has no device node. Reporting an error there would say the
 * adapter failed, which is a claim about the user's hardware that is not true.
 */
it("reports unsupported rather than error on a shell without the hardware", async () => {
  const open = jest.fn()
  const result = await connectSerialFromDock({
    config,
    store: store(),
    open,
    transportChain: () => ["ws", "webrtc"],
  })
  expect(result).toEqual({ kind: "unsupported" })
  expect(open).not.toHaveBeenCalled()
})

it("reports unsupported when no terminal transport is reachable at all", async () => {
  const result = await connectSerialFromDock({
    config,
    store: store(),
    open: jest.fn(),
    transportChain: () => [],
  })
  expect(result).toEqual({ kind: "unsupported" })
})

it("registers the live handle, the row, and the store wiring together", async () => {
  const target = store()
  const session = fakeSession()
  const result = await connectSerialFromDock({
    config,
    projectId: "proj-a",
    store: target,
    open: jest.fn().mockResolvedValue(session),
    transportChain: () => ["tauri-channel"],
  })

  expect(result).toEqual({ kind: "connected", sessionId: "sess-1" })
  expect(registerLiveSessionMock).toHaveBeenCalledWith(session)
  // The tab title is the port path, which is what identifies the device. The
  // session's own `shell` carries the line settings for the "where am I" chip.
  expect(target.registerSession).toHaveBeenCalledWith(session.info, {
    title: "/dev/cu.usbserial-1420",
  })
  expect(wireSessionToStoreMock).toHaveBeenCalledWith(session, target, expect.anything())
  expect(dispatchTerminalLifecycleMock).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "spawned", sessionId: "sess-1" })
  )
})

it("leaves nothing registered when the port refuses to open", async () => {
  const target = store()
  const result = await connectSerialFromDock({
    config,
    store: target,
    open: jest.fn().mockRejectedValue(new Error("permission denied")),
    transportChain: () => ["tauri-channel"],
  })
  expect(result).toEqual({ kind: "error", message: "permission denied" })
  expect(registerLiveSessionMock).not.toHaveBeenCalled()
  expect(target.registerSession).not.toHaveBeenCalled()
  expect(wireSessionToStoreMock).not.toHaveBeenCalled()
})
